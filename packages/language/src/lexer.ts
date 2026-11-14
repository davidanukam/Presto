export type TokenKind =
  | "newline"
  | "indent"
  | "dedent"
  | "eof"
  | "ident"
  | "number"
  | "string"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "colon"
  | "dot"
  | "eq"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "eqeq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte";

export type Token = {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
  contentStart?: number;
};

export type LexError = { message: string; start: number; end: number; line: number; column: number };

export function lex(source: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const indents = [0];
  let i = 0;
  let line = 1;
  let column = 1;
  let atLineStart = true;
  let paren = 0;

  const bump = (count = 1) => {
    for (let n = 0; n < count; n++) {
      if (source[i] === "\n") {
        line += 1;
        column = 1;
      } else column += 1;
      i += 1;
    }
  };

  const push = (kind: TokenKind, value: string, start: number, end: number, tokenLine: number, tokenColumn: number, contentStart?: number) => {
    tokens.push({ kind, value, start, end, line: tokenLine, column: tokenColumn, contentStart });
  };

  const error = (message: string, start = i, tokenLine = line, tokenColumn = column) => {
    errors.push({ message, start, end: i, line: tokenLine, column: tokenColumn });
  };

  const skipBreak = () => {
    if (source[i] === "\r") bump();
    if (source[i] === "\n") bump();
  };

  while (i < source.length) {
    if (atLineStart && paren === 0) {
      const startLine = line;
      const startCol = column;
      const startIndex = i;
      let spaces = 0;
      while (source[i] === " " || source[i] === "\t") {
        spaces += source[i] === "\t" ? 4 : 1;
        bump();
      }
      if (i >= source.length) break;
      if (source[i] === "\r" || source[i] === "\n") {
        skipBreak();
        continue;
      }
      if (source[i] === "#") {
        while (i < source.length && source[i] !== "\n" && source[i] !== "\r") bump();
        skipBreak();
        continue;
      }
      atLineStart = false;
      if (spaces > indents[indents.length - 1]!) {
        indents.push(spaces);
        push("indent", "", startIndex, i, startLine, startCol);
      } else if (spaces < indents[indents.length - 1]!) {
        while (spaces < indents[indents.length - 1]!) {
          indents.pop();
          push("dedent", "", startIndex, i, startLine, startCol);
        }
        if (spaces !== indents[indents.length - 1]) {
          error("indentation does not match an outer block", startIndex, startLine, startCol);
        }
      }
    }

    if (i >= source.length) break;
    const ch = source[i]!;
    if (ch === " " || ch === "\t") {
      bump();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const start = i;
      const tokenLine = line;
      const tokenColumn = column;
      skipBreak();
      if (paren === 0) {
        push("newline", "\n", start, i, tokenLine, tokenColumn);
        atLineStart = true;
      }
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") bump();
      continue;
    }

    const start = i;
    const tokenLine = line;
    const tokenColumn = column;

    if (ch === '"' || ch === "'") {
      const triple = source.startsWith(ch + ch + ch, i);
      const qlen = triple ? 3 : 1;
      bump(qlen);
      const contentStart = i;
      let closed = false;
      while (i < source.length) {
        if (source.startsWith(triple ? ch + ch + ch : ch, i)) {
          let slashes = 0;
          let k = i - 1;
          while (k >= contentStart && source[k] === "\\") {
            slashes += 1;
            k -= 1;
          }
          if (slashes % 2 === 0) {
            const contentEnd = i;
            bump(qlen);
            push("string", source.slice(contentStart, contentEnd), start, i, tokenLine, tokenColumn, contentStart);
            closed = true;
            break;
          }
        }
        bump();
      }
      if (!closed) error("unterminated string", start, tokenLine, tokenColumn);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      while (i < source.length && /[0-9]/.test(source[i]!)) bump();
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        bump();
        while (i < source.length && /[0-9]/.test(source[i]!)) bump();
      }
      push("number", source.slice(start, i), start, i, tokenLine, tokenColumn);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) bump();
      push("ident", source.slice(start, i), start, i, tokenLine, tokenColumn);
      continue;
    }

    const two = source.slice(i, i + 2);
    const pairs: Record<string, TokenKind> = {
      "==": "eqeq",
      "!=": "neq",
      "<=": "lte",
      ">=": "gte",
    };
    if (pairs[two]) {
      bump(2);
      push(pairs[two], two, start, i, tokenLine, tokenColumn);
      continue;
    }

    const singles: Record<string, TokenKind> = {
      "(": "lparen",
      ")": "rparen",
      "[": "lbracket",
      "]": "rbracket",
      ",": "comma",
      ":": "colon",
      ".": "dot",
      "=": "eq",
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "<": "lt",
      ">": "gt",
    };
    if (singles[ch]) {
      if (ch === "(" || ch === "[") paren += 1;
      if (ch === ")" || ch === "]") paren = Math.max(0, paren - 1);
      bump();
      push(singles[ch], ch, start, i, tokenLine, tokenColumn);
      continue;
    }

    error(`unexpected '${ch}'`, start, tokenLine, tokenColumn);
    bump();
  }

  if (!atLineStart && paren === 0) push("newline", "\n", i, i, line, column);
  while (indents.length > 1) {
    indents.pop();
    push("dedent", "", i, i, line, column);
  }
  push("eof", "", i, i, line, column);
  return { tokens, errors };
}
