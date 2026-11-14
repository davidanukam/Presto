import type { Token } from "./lexer";

export type Span = { start: number; end: number };

export type Expr =
  | { type: "number"; value: number; span: Span }
  | { type: "string"; value: string; span: Span; contentStart: number }
  | { type: "name"; name: string; span: Span }
  | { type: "list"; items: Expr[]; span: Span }
  | { type: "unary"; op: "-" | "not"; expr: Expr; span: Span }
  | { type: "binary"; op: string; left: Expr; right: Expr; span: Span }
  | { type: "call"; callee: Expr; args: ArgExpr[]; span: Span }
  | { type: "attr"; object: Expr; name: string; span: Span };

export type ArgExpr = { name?: string; value: Expr; span: Span };

export type Stmt =
  | { type: "assign"; name: string; value: Expr; span: Span }
  | { type: "expr"; expr: Expr; span: Span }
  | { type: "return"; value?: Expr; span: Span }
  | { type: "def"; name: string; params: string[]; body: Stmt[]; span: Span }
  | { type: "for"; name: string; iter: Expr; body: Stmt[]; span: Span }
  | { type: "if"; arms: { test: Expr; body: Stmt[] }[]; elseBody?: Stmt[]; span: Span }
  | { type: "with"; context: Expr; body: Stmt[]; span: Span }
  | { type: "repeat"; times: Expr; body: Stmt[]; span: Span }
  | { type: "ending"; number: Expr; body: Stmt[]; span: Span };

export class ParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set([
  "def",
  "for",
  "in",
  "if",
  "elif",
  "else",
  "with",
  "return",
  "repeat",
  "ending",
  "and",
  "or",
  "not",
  "True",
  "False",
  "None",
  "while",
  "import",
  "class",
]);

export function parse(tokens: Token[]): Stmt[] {
  const parser = new Parser(tokens);
  return parser.program();
}

class Parser {
  private index = 0;

  constructor(private tokens: Token[]) {}

  program(): Stmt[] {
    this.skipNewlines();
    const body: Stmt[] = [];
    while (!this.check("eof")) {
      const stmt = this.statement();
      body.push(stmt);
      this.finishStatement(stmt);
      this.skipNewlines();
    }
    return body;
  }

  private statement(): Stmt {
    if (this.checkIdent("def")) return this.defStmt();
    if (this.checkIdent("for")) return this.forStmt();
    if (this.checkIdent("if")) return this.ifStmt();
    if (this.checkIdent("with")) return this.withStmt();
    if (this.checkIdent("repeat")) return this.repeatStmt();
    if (this.checkIdent("ending")) return this.endingStmt();
    if (this.checkIdent("return")) return this.returnStmt();
    if (this.checkIdent("while")) throw this.fail("Presto has no while. Use for, or repeat() for a repeated passage");
    if (this.checkIdent("import")) throw this.fail("Presto has no import");
    if (this.checkIdent("class")) throw this.fail("Presto has no classes");
    if (this.check("ident") && !KEYWORDS.has(this.peek().value) && this.peekKind(1) === "eq") {
      return this.assign();
    }
    const expr = this.expression();
    return { type: "expr", expr, span: expr.span };
  }

  private assign(): Stmt {
    const name = this.advance();
    this.expect("eq");
    const value = this.expression();
    return { type: "assign", name: name.value, value, span: { start: name.start, end: value.span.end } };
  }

  private returnStmt(): Stmt {
    const token = this.advance();
    if (this.check("newline") || this.check("dedent") || this.check("eof")) {
      return { type: "return", span: { start: token.start, end: token.end } };
    }
    const value = this.expression();
    return { type: "return", value, span: { start: token.start, end: value.span.end } };
  }

  private defStmt(): Stmt {
    const token = this.advance();
    const name = this.expect("ident");
    this.expect("lparen");
    const params: string[] = [];
    if (!this.check("rparen")) {
      do {
        params.push(this.expect("ident").value);
      } while (this.eat("comma"));
    }
    this.expect("rparen");
    const body = this.suite();
    const end = body.length ? body[body.length - 1]!.span.end : name.end;
    return { type: "def", name: name.value, params, body, span: { start: token.start, end } };
  }

  private forStmt(): Stmt {
    const token = this.advance();
    const name = this.expect("ident");
    if (!this.checkIdent("in")) throw this.fail("expected in");
    this.advance();
    const iter = this.expression();
    const body = this.suite();
    return { type: "for", name: name.value, iter, body, span: { start: token.start, end: bodyEnd(body, iter.span.end) } };
  }

  private ifStmt(): Stmt {
    const token = this.advance();
    const arms: { test: Expr; body: Stmt[] }[] = [];
    const first = this.expression();
    arms.push({ test: first, body: this.suite() });
    while (this.checkIdent("elif")) {
      this.advance();
      const test = this.expression();
      arms.push({ test, body: this.suite() });
    }
    let elseBody: Stmt[] | undefined;
    if (this.checkIdent("else")) {
      this.advance();
      elseBody = this.suite();
    }
    const tail = elseBody ?? arms[arms.length - 1]!.body;
    return { type: "if", arms, elseBody, span: { start: token.start, end: bodyEnd(tail, token.end) } };
  }

  private withStmt(): Stmt {
    const token = this.advance();
    const context = this.expression();
    const body = this.suite();
    return { type: "with", context, body, span: { start: token.start, end: bodyEnd(body, context.span.end) } };
  }

  private repeatStmt(): Stmt {
    const token = this.advance();
    this.expect("lparen");
    const times = this.expression();
    this.expect("rparen");
    const body = this.suite();
    return { type: "repeat", times, body, span: { start: token.start, end: bodyEnd(body, times.span.end) } };
  }

  private endingStmt(): Stmt {
    const token = this.advance();
    this.expect("lparen");
    const number = this.expression();
    this.expect("rparen");
    const body = this.suite();
    return { type: "ending", number, body, span: { start: token.start, end: bodyEnd(body, number.span.end) } };
  }

  private suite(): Stmt[] {
    this.expect("colon");
    if (this.check("newline")) {
      this.advance();
      this.skipNewlines();
      if (!this.check("indent")) throw this.fail("expected an indented block");
      this.advance();
      const body: Stmt[] = [];
      while (!this.check("dedent") && !this.check("eof")) {
        this.skipNewlines();
        if (this.check("dedent") || this.check("eof")) break;
        const stmt = this.statement();
        body.push(stmt);
        this.finishStatement(stmt);
      }
      if (body.length === 0) throw this.fail("this block is empty");
      if (this.check("dedent")) this.advance();
      return body;
    }
    const stmt = this.statement();
    return [stmt];
  }

  /** A block consumes the newline that closed it, so the next statement can follow immediately. */
  private finishStatement(stmt: Stmt) {
    if (this.check("newline")) this.advance();
    else if (!blockStatement(stmt) && !this.check("eof") && !this.check("dedent")) {
      throw this.fail("expected a new line after this statement");
    }
  }

  private expression(): Expr {
    return this.or();
  }

  private or(): Expr {
    let left = this.and();
    while (this.checkIdent("or")) {
      this.advance();
      const right = this.and();
      left = { type: "binary", op: "or", left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.checkIdent("and")) {
      this.advance();
      const right = this.not();
      left = { type: "binary", op: "and", left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private not(): Expr {
    if (this.checkIdent("not")) {
      const token = this.advance();
      const expr = this.not();
      return { type: "unary", op: "not", expr, span: { start: token.start, end: expr.span.end } };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    let left = this.addition();
    while (this.check("eqeq") || this.check("neq") || this.check("lt") || this.check("gt") || this.check("lte") || this.check("gte")) {
      const op = this.advance().value;
      const right = this.addition();
      left = { type: "binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private addition(): Expr {
    let left = this.multiply();
    while (this.check("plus") || this.check("minus")) {
      const op = this.advance().value;
      const right = this.multiply();
      left = { type: "binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private multiply(): Expr {
    let left = this.unary();
    while (this.check("star") || this.check("slash")) {
      const op = this.advance().value;
      const right = this.unary();
      left = { type: "binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private unary(): Expr {
    if (this.check("minus")) {
      const token = this.advance();
      const expr = this.unary();
      return { type: "unary", op: "-", expr, span: { start: token.start, end: expr.span.end } };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    while (true) {
      if (this.check("lparen")) {
        const args = this.args();
        const end = this.previous().end;
        expr = { type: "call", callee: expr, args, span: { start: expr.span.start, end } };
      } else if (this.eat("dot")) {
        const name = this.expect("ident");
        expr = { type: "attr", object: expr, name: name.value, span: { start: expr.span.start, end: name.end } };
      } else break;
    }
    return expr;
  }

  private args(): ArgExpr[] {
    this.expect("lparen");
    const args: ArgExpr[] = [];
    if (!this.check("rparen")) {
      let sawName = false;
      do {
        if (this.check("ident") && this.peekKind(1) === "eq") {
          sawName = true;
          const name = this.advance();
          this.expect("eq");
          const value = this.expression();
          args.push({ name: name.value, value, span: { start: name.start, end: value.span.end } });
        } else {
          if (sawName) throw this.fail("put keyword arguments after positional ones");
          const value = this.expression();
          args.push({ value, span: value.span });
        }
      } while (this.eat("comma"));
    }
    this.expect("rparen");
    return args;
  }

  private primary(): Expr {
    const token = this.peek();
    if (this.check("number")) {
      this.advance();
      return { type: "number", value: Number(token.value), span: spanOf(token) };
    }
    if (this.check("string")) {
      this.advance();
      return {
        type: "string",
        value: token.value,
        contentStart: token.contentStart ?? token.start,
        span: spanOf(token),
      };
    }
    if (this.checkIdent("True") || this.checkIdent("False") || this.checkIdent("None")) {
      this.advance();
      return { type: "name", name: token.value, span: spanOf(token) };
    }
    if (this.check("ident")) {
      this.advance();
      return { type: "name", name: token.value, span: spanOf(token) };
    }
    if (this.eat("lparen")) {
      const expr = this.expression();
      this.expect("rparen");
      return expr;
    }
    if (this.eat("lbracket")) {
      const items: Expr[] = [];
      if (!this.check("rbracket")) {
        do {
          if (this.check("rbracket")) break;
          items.push(this.expression());
        } while (this.eat("comma"));
      }
      const end = this.expect("rbracket");
      return { type: "list", items, span: { start: token.start, end: end.end } };
    }
    throw this.fail("expected an expression");
  }

  private skipNewlines() {
    while (this.check("newline")) this.advance();
  }

  private check(kind: Token["kind"]): boolean {
    return this.peek().kind === kind;
  }

  private checkIdent(value: string): boolean {
    const token = this.peek();
    return token.kind === "ident" && token.value === value;
  }

  private eat(kind: Token["kind"]): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  private expect(kind: Token["kind"]): Token {
    if (!this.check(kind)) throw this.fail(`expected ${kind}`);
    return this.advance();
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)]!;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peekKind(offset: number): Token["kind"] | undefined {
    return this.tokens[this.index + offset]?.kind;
  }

  private fail(message: string): ParseError {
    const token = this.peek();
    return new ParseError(message, token.start, Math.max(token.end, token.start + 1), token.line, token.column);
  }
}

function spanOf(token: Token): Span {
  return { start: token.start, end: token.end };
}

function blockStatement(stmt: Stmt): boolean {
  return stmt.type === "def" || stmt.type === "for" || stmt.type === "if" || stmt.type === "with" || stmt.type === "repeat" || stmt.type === "ending";
}

function bodyEnd(body: Stmt[], fallback: number): number {
  return body.length ? body[body.length - 1]!.span.end : fallback;
}
