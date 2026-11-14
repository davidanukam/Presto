export type Rational = { readonly n: number; readonly d: number };

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function r(n: number, d = 1): Rational {
  if (!Number.isInteger(n) || !Number.isInteger(d)) {
    throw new Error("rational numbers must be integers");
  }
  if (d < 0) {
    n = -n;
    d = -d;
  }
  if (d === 0) throw new Error("zero denominator");
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO: Rational = { n: 0, d: 1 };
export const ONE: Rational = { n: 1, d: 1 };

export function add(a: Rational, b: Rational): Rational {
  return r(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rational, b: Rational): Rational {
  return r(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rational, b: Rational): Rational {
  return r(a.n * b.n, a.d * b.d);
}

export function div(a: Rational, b: Rational): Rational {
  return r(a.n * b.d, a.d * b.n);
}

export function cmp(a: Rational, b: Rational): number {
  return a.n * b.d - b.n * a.d;
}

export function eq(a: Rational, b: Rational): boolean {
  return a.n === b.n && a.d === b.d;
}

export function isZero(a: Rational): boolean {
  return a.n === 0;
}

export function toNumber(a: Rational): number {
  return a.n / a.d;
}

export function formatRational(a: Rational): string {
  return a.d === 1 ? String(a.n) : `${a.n}/${a.d}`;
}

/** Quarter-lengths for an American duration. `/8` is an eighth, which is 1/2 of a quarter. */
export function durationFromDenom(denom: number, dots: number): { base: Rational; duration: Rational } {
  const base = r(4, denom);
  let duration = base;
  let extra = base;
  for (let i = 0; i < dots; i++) {
    extra = mul(extra, r(1, 2));
    duration = add(duration, extra);
  }
  return { base, duration };
}

export function chooseDivisions(durations: Rational[]): number {
  let div = 480;
  for (const d of durations) {
    if (d.n === 0) continue;
    const g = gcd(div, d.d);
    div *= d.d / g;
  }
  return div;
}

export function toTicks(duration: Rational, divisions: number): number {
  const ticks = (duration.n * divisions) / duration.d;
  if (!Number.isInteger(ticks)) {
    throw new Error(`duration ${formatRational(duration)} does not fit ${divisions} divisions`);
  }
  return ticks;
}
