import { formatTime, measureQuarters, quartersPerBeat, type TimeSignature } from "./pitch";
import { cmp, div, eq, formatRational, ZERO, type Rational } from "./rational";
import type { ScoreEvent, SourceSpan } from "./model";

export type BarIssue = {
  message: string;
  start: number;
  end: number;
};

export function sumDuration(events: ScoreEvent[]): Rational {
  return events.reduce((total, event) => addSafe(total, event.duration), ZERO);
}

function addSafe(a: Rational, b: Rational): Rational {
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const g = gcdLocal(Math.abs(n), d);
  return { n: n / g, d: d / g };
}

function gcdLocal(a: number, b: number): number {
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

export function formatBeats(length: Rational): string {
  const text = formatRational(length);
  const singular = length.n === 1 && length.d === 1;
  return `${text} ${singular ? "beat" : "beats"}`;
}

export function spanOf(events: ScoreEvent[], fallback?: SourceSpan): SourceSpan {
  const first = events.find((event) => event.span);
  const last = [...events].reverse().find((event) => event.span);
  if (first?.span && last?.span) return { start: first.span.start, end: last.span.end };
  return fallback ?? { start: 0, end: 0 };
}

/** Reject a bar whose sounding length is not the time signature (or the pickup). */
export function checkBar(
  events: ScoreEvent[],
  expected: Rational,
  measureNumber: number,
  time: TimeSignature,
  fallback?: SourceSpan,
): BarIssue | null {
  const sum = sumDuration(events);
  if (eq(sum, expected) || cmp(sum, expected) === 0) return null;
  const beats = div(sum, quartersPerBeat(time));
  const span = spanOf(events, fallback);
  return {
    message: `measure ${measureNumber} is ${formatBeats(beats)} long, time is ${formatTime(time)}`,
    start: span.start,
    end: span.end,
  };
}

export function expectedQuarters(time: TimeSignature, measureIndex: number, pickup?: Rational): Rational {
  if (measureIndex === 0 && pickup) return pickup;
  return measureQuarters(time);
}
