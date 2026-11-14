import { buildTimeline, type Score, type SourceSpan, type Timeline } from "@presto/score";
import { Interpreter, RuntimeError, positionOf } from "./interpret";
import { lex, type LexError } from "./lexer";
import { ParseError, parse } from "./parser";

export type CompileError = {
  message: string;
  start: number;
  end: number;
  line: number;
  column: number;
};

export type CompileResult = {
  ok: boolean;
  score?: Score;
  timeline?: Timeline;
  errors: CompileError[];
};

export function compile(source: string): CompileResult {
  const lexed = lex(source);
  if (lexed.errors.length) return { ok: false, errors: lexed.errors.map(locateLex) };
  try {
    const body = parse(lexed.tokens);
    const interpreter = new Interpreter(source);
    const score = interpreter.run(body);
    const errors = interpreter.issues.map((issue) => locate(source, issue.message, issue));
    if (!score || errors.length) return { ok: false, errors };
    const timeline = buildTimeline(score);
    return { ok: true, score, timeline, errors: [] };
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        ok: false,
        errors: [
          {
            message: error.message,
            start: error.start,
            end: error.end,
            line: error.line,
            column: error.column,
          },
        ],
      };
    }
    if (error instanceof RuntimeError) {
      return { ok: false, errors: [locate(source, error.message, error.span)] };
    }
    throw error;
  }
}

function locate(source: string, message: string, span: SourceSpan): CompileError {
  const pos = positionOf(source, span.start);
  return { message, start: span.start, end: Math.max(span.end, span.start), line: pos.line, column: pos.column };
}

function locateLex(error: LexError): CompileError {
  return {
    message: error.message,
    start: error.start,
    end: error.end,
    line: error.line,
    column: error.column,
  };
}
