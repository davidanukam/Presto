import {
  durationFromDenom,
  isArticulation,
  isDynamic,
  ONE,
  r,
  type Articulation,
  type DynamicName,
  type NoteEvent,
  type RestEvent,
  type ScoreEvent,
  type SourceSpan,
  type Tuplet,
} from "@presto/score";

export type MiniIssue = { message: string; start: number; end: number };

export type MiniResult = {
  bars: ScoreEvent[][];
  issues: MiniIssue[];
};

type Sticky = { base: ReturnType<typeof r>; dots: number; octave?: number };

const PITCH =
  /^([a-gA-G])(#{1,2}|b{1,2}|n)?(\d)?(?:\/(\d+)(\.+)?)?(~)?$/;
const REST = /^r(?:\/(\d+)(\.+)?)?$/i;

export function parseMini(source: string, baseOffset = 0): MiniResult {
  const issues: MiniIssue[] = [];
  const bars: ScoreEvent[][] = [];
  let bar: ScoreEvent[] = [];
  const sticky: Sticky = { base: ONE, dots: 0 };
  let pendingDynamic: DynamicName | undefined;
  let pendingArts: Articulation[] = [];
  let slurArm = false;
  let i = 0;

  const finishBar = () => {
    bars.push(bar);
    bar = [];
  };

  const fail = (message: string, start: number, end: number) => {
    issues.push({ message, start: start + baseOffset, end: end + baseOffset });
  };

  const takePending = (note: NoteEvent) => {
    if (pendingDynamic) {
      note.dynamic = pendingDynamic;
      pendingDynamic = undefined;
    }
    if (pendingArts.length) {
      note.articulations.push(...pendingArts);
      pendingArts = [];
    }
    if (slurArm) {
      note.slurStart = true;
      slurArm = false;
    }
  };

  const pushNote = (note: NoteEvent) => {
    takePending(note);
    note.span = shift(note.span);
    bar.push(note);
  };

  const shift = (span?: SourceSpan): SourceSpan | undefined => {
    if (!span) return undefined;
    return { start: span.start + baseOffset, end: span.end + baseOffset };
  };

  function skipWs() {
    while (i < source.length && /[ \t\r\n]/.test(source[i]!)) i++;
  }

  function readToken(): { text: string; start: number; end: number } | null {
    const start = i;
    while (i < source.length && !/[ \t\r\n|()<>"]/.test(source[i]!)) i++;
    if (i === start) return null;
    return { text: source.slice(start, i), start, end: i };
  }

  function parseDuration(denom: string | undefined, dotsText: string | undefined, where: number): {
    base: ReturnType<typeof r>;
    dots: number;
    duration: ReturnType<typeof r>;
  } | null {
    if (!denom) return { base: sticky.base, dots: sticky.dots, duration: dotted(sticky.base, sticky.dots) };
    const value = Number(denom);
    if (![1, 2, 4, 8, 16, 32].includes(value)) {
      fail(`duration /${denom} is not 1, 2, 4, 8, 16, or 32`, where, where + denom.length + 1);
      return null;
    }
    const dots = dotsText?.length ?? 0;
    const { base, duration } = durationFromDenom(value, dots);
    sticky.base = base;
    sticky.dots = dots;
    return { base, dots, duration };
  }

  function parsePitchWord(token: { text: string; start: number; end: number }): NoteEvent | null {
    const match = PITCH.exec(token.text);
    if (!match) {
      fail(`can't read note ${token.text}`, token.start, token.end);
      return null;
    }
    const step = match[1]!.toUpperCase() as NoteEvent["pitches"][number]["step"];
    const acc = match[2];
    let alter = 0;
    if (acc?.startsWith("#")) alter = acc.length;
    else if (acc?.startsWith("b")) alter = -acc.length;
    let octave: number;
    if (match[3]) {
      octave = Number(match[3]);
      sticky.octave = octave;
    } else if (sticky.octave !== undefined) {
      octave = sticky.octave;
    } else {
      fail(`give ${token.text} an octave, like ${token.text}4`, token.start, token.end);
      return null;
    }
    const timing = parseDuration(match[4], match[5], token.start);
    if (!timing) return null;
    return {
      kind: "note",
      pitches: [{ step, alter, octave }],
      duration: timing.duration,
      base: timing.base,
      dots: timing.dots,
      articulations: [],
      tieStart: Boolean(match[6]),
      span: { start: token.start, end: token.end },
    };
  }

  function parseRestWord(token: { text: string; start: number; end: number }): RestEvent | null {
    const match = REST.exec(token.text);
    if (!match) return null;
    const timing = parseDuration(match[1], match[2], token.start);
    if (!timing) return null;
    return {
      kind: "rest",
      duration: timing.duration,
      base: timing.base,
      dots: timing.dots,
      span: shift({ start: token.start, end: token.end }),
    };
  }

  function parseChord() {
    const start = i;
    i++; // <
    const pitches: NoteEvent["pitches"] = [];
    let guard = 0;
    while (i < source.length && source[i] !== ">" && guard++ < 64) {
      skipWs();
      if (source[i] === ">") break;
      const token = readToken();
      if (!token) {
        fail("chord is missing a pitch", start, i + 1);
        return;
      }
      const pitchOnly = /^([a-gA-G])(#{1,2}|b{1,2}|n)?(\d)?$/.exec(token.text);
      if (!pitchOnly) {
        fail(`can't read chord pitch ${token.text}`, token.start, token.end);
        return;
      }
      const step = pitchOnly[1]!.toUpperCase() as NoteEvent["pitches"][number]["step"];
      const acc = pitchOnly[2];
      let alter = 0;
      if (acc?.startsWith("#")) alter = acc.length;
      else if (acc?.startsWith("b")) alter = -acc.length;
      let octave: number;
      if (pitchOnly[3]) {
        octave = Number(pitchOnly[3]);
        sticky.octave = octave;
      } else if (sticky.octave !== undefined) octave = sticky.octave;
      else {
        fail(`give ${token.text} an octave, like ${token.text}4`, token.start, token.end);
        return;
      }
      pitches.push({ step, alter, octave });
    }
    if (source[i] !== ">") {
      fail("chord is missing >", start, i);
      return;
    }
    i++;
    let denom: string | undefined;
    let dotsText: string | undefined;
    let tie = false;
    const dur = /^\/(\d+)(\.+)?(~)?/.exec(source.slice(i));
    if (dur) {
      denom = dur[1];
      dotsText = dur[2];
      tie = Boolean(dur[3]);
      i += dur[0].length;
    }
    const timing = parseDuration(denom, dotsText, start);
    if (!timing || pitches.length === 0) return;
    pushNote({
      kind: "note",
      pitches,
      duration: timing.duration,
      base: timing.base,
      dots: timing.dots,
      articulations: [],
      tieStart: tie,
      span: { start, end: i },
    });
  }

  function parseTuplet() {
    const start = i;
    i++; // (
    skipWs();
    const num = /^(\d+)/.exec(source.slice(i));
    if (!num) {
      const prev = bar[bar.length - 1];
      if (prev?.kind === "note") prev.slurStart = true;
      else slurArm = true;
      return;
    }
    const actual = Number(num[1]);
    i += num[1]!.length;
    if (actual < 2 || actual > 9) {
      fail("tuplets go from 2 to 9", start, i);
      return;
    }
    const group: ScoreEvent[] = [];
    let guard = 0;
    while (i < source.length && source[i] !== ")" && guard++ < 64) {
      skipWs();
      if (i >= source.length || source[i] === ")") break;
      if (source[i] === "|") {
        fail("a tuplet can't cross a barline", i, i + 1);
        return;
      }
      const before = bar.length;
      parseOne(true);
      if (bar.length > before) {
        const event = bar.pop()!;
        group.push(event);
      }
    }
    if (source[i] === ")") i++;
    else fail("tuplet is missing )", start, i);
    const normal = actual === 2 ? 3 : largestPowerBelow(actual);
    const tuplet: Tuplet = { actual, normal };
    group.forEach((event, index) => {
      event.tuplet = tuplet;
      event.duration = mulRatio(event.duration, normal, actual);
      if (index === 0) event.tupletStart = true;
      if (index === group.length - 1) event.tupletStop = true;
      bar.push(event);
    });
  }

  function parseOne(insideTuplet: boolean) {
    skipWs();
    if (i >= source.length) return;
    const ch = source[i]!;
    if (ch === "<") {
      parseChord();
      return;
    }
    if (ch === "(") {
      if (insideTuplet) {
        fail("tuplets can't nest", i, i + 1);
        i++;
        return;
      }
      parseTuplet();
      return;
    }
    if (ch === ")") {
      const prev = bar[bar.length - 1];
      if (prev?.kind === "note") prev.slurStop = true;
      i++;
      return;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let text = "";
      while (i < source.length && source[i] !== '"') {
        text += source[i];
        i++;
      }
      if (source[i] === '"') i++;
      const prev = bar[bar.length - 1];
      if (prev?.kind === "note") prev.lyric = text;
      else fail("a lyric needs a note before it", start, i);
      return;
    }
    const token = readToken();
    if (!token) {
      fail(`unexpected '${ch}'`, i, i + 1);
      i++;
      return;
    }
    if (isDynamic(token.text)) {
      pendingDynamic = token.text;
      return;
    }
    if (isArticulation(token.text)) {
      const prev = bar[bar.length - 1];
      if (prev?.kind === "note") prev.articulations.push(token.text);
      else pendingArts.push(token.text);
      return;
    }
    if (REST.test(token.text)) {
      const rest = parseRestWord(token);
      if (rest) bar.push(rest);
      return;
    }
    if (PITCH.test(token.text) && !isDynamic(token.text)) {
      const note = parsePitchWord(token);
      if (note) pushNote(note);
      return;
    }
    fail(`unknown mark ${token.text}`, token.start, token.end);
  }

  while (i < source.length) {
    skipWs();
    if (i >= source.length) break;
    if (source[i] === "|") {
      finishBar();
      i++;
      continue;
    }
    parseOne(false);
  }
  if (bar.length > 0 || bars.length === 0) finishBar();
  if (bars.length > 1 && bars[bars.length - 1]!.length === 0) bars.pop();
  if (bars.length === 1 && bars[0]!.length === 0) bars.pop();
  tiePass(bars);
  return { bars, issues };
}

function dotted(base: ReturnType<typeof r>, dots: number) {
  return durationFromDenom(denomOf(base), dots).duration;
}

function denomOf(base: ReturnType<typeof r>): number {
  // base quarters = 4/denom, so denom = 4 / base = 4 * d / n
  if (base.n === 0) return 4;
  return (4 * base.d) / base.n;
}

function mulRatio(duration: ReturnType<typeof r>, normal: number, actual: number) {
  const n = duration.n * normal;
  const d = duration.d * actual;
  const g = gcd(Math.abs(n), d);
  return r(n / g, d / g);
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function largestPowerBelow(actual: number): number {
  let n = 1;
  while (n * 2 < actual) n *= 2;
  return n;
}

function tiePass(bars: ScoreEvent[][]) {
  let open = false;
  for (const bar of bars) {
    for (const event of bar) {
      if (event.kind !== "note") {
        open = false;
        continue;
      }
      if (open) {
        event.tieStop = true;
        open = false;
      }
      if (event.tieStart) open = true;
    }
  }
}
