import { r, type Rational } from "./rational";

export const STEPS = ["C", "D", "E", "F", "G", "A", "B"] as const;
export type Step = (typeof STEPS)[number];

const SEMI = [0, 2, 4, 5, 7, 9, 11];

export type Pitch = {
  step: Step;
  /** -2..2. Spelling is the step plus this alter, never a respelling. */
  alter: number;
  octave: number;
};

export function isStep(value: string): value is Step {
  return (STEPS as readonly string[]).includes(value);
}

export function midiOf(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + SEMI[STEPS.indexOf(pitch.step)] + pitch.alter;
}

export function freqOf(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function pitchName(pitch: Pitch): string {
  const acc =
    pitch.alter === 0 ? "" : pitch.alter > 0 ? "#".repeat(pitch.alter) : "b".repeat(-pitch.alter);
  return `${pitch.step.toLowerCase()}${acc}${pitch.octave}`;
}

export type Interval = { number: number; semitones: number; down: boolean };

const INTERVALS: Record<string, { number: number; semitones: number }> = {
  P1: { number: 1, semitones: 0 },
  m2: { number: 2, semitones: 1 },
  M2: { number: 2, semitones: 2 },
  m3: { number: 3, semitones: 3 },
  M3: { number: 3, semitones: 4 },
  P4: { number: 4, semitones: 5 },
  A4: { number: 4, semitones: 6 },
  d5: { number: 5, semitones: 6 },
  P5: { number: 5, semitones: 7 },
  m6: { number: 6, semitones: 8 },
  M6: { number: 6, semitones: 9 },
  m7: { number: 7, semitones: 10 },
  M7: { number: 7, semitones: 11 },
  P8: { number: 8, semitones: 12 },
};

export function parseInterval(text: string): Interval | null {
  const down = text.startsWith("-");
  const name = down ? text.slice(1) : text;
  const found = INTERVALS[name];
  if (!found) return null;
  return { ...found, down };
}

export function transposePitch(pitch: Pitch, interval: Interval): Pitch {
  const sign = interval.down ? -1 : 1;
  const from = STEPS.indexOf(pitch.step);
  const raw = from + sign * (interval.number - 1);
  const to = ((raw % 7) + 7) % 7;
  const octaveDelta = Math.floor(raw / 7);
  const targetOctave = pitch.octave + octaveDelta;
  const naturalMidi = (targetOctave + 1) * 12 + SEMI[to];
  const desiredMidi = midiOf(pitch) + sign * interval.semitones;
  let alter = desiredMidi - naturalMidi;
  let octave = targetOctave;
  while (alter > 2) {
    alter -= 12;
    octave += 1;
  }
  while (alter < -2) {
    alter += 12;
    octave -= 1;
  }
  return { step: STEPS[to]!, alter, octave };
}

/** Transpose every scientific pitch in a notes string. Durations and barlines stay put. */
export function transposeMusic(source: string, intervalText: string): string {
  const interval = parseInterval(intervalText);
  if (!interval) {
    throw new Error(`unknown interval ${intervalText}`);
  }
  return source.replace(
    /([a-gA-G](?:#{1,2}|b{1,2}|n)?\d)((?:\/\d+\.?)?~?)/g,
    (full, pitchText: string, suffix: string) => {
      const parsed = parsePitchToken(pitchText);
      if (!parsed) return full;
      return pitchName(transposePitch(parsed, interval)) + suffix;
    },
  );
}

export function parsePitchToken(token: string): Pitch | null {
  const match = /^([a-gA-G])(#{1,2}|b{1,2}|n)?(\d)$/.exec(token);
  if (!match) return null;
  const step = match[1]!.toUpperCase();
  if (!isStep(step)) return null;
  let alter = 0;
  const acc = match[2];
  if (acc?.startsWith("#")) alter = acc.length;
  else if (acc?.startsWith("b")) alter = -acc.length;
  return { step, alter, octave: Number(match[3]) };
}

export type KeySignature = { name: string; fifths: number };

const KEYS: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  "F#": 6,
  "C#": 7,
  F: -1,
  Bb: -2,
  Eb: -3,
  Ab: -4,
  Db: -5,
  Gb: -6,
  Cb: -7,
};

export function parseKey(name: string): KeySignature | null {
  const fifths = KEYS[name];
  if (fifths === undefined) return null;
  return { name, fifths };
}

const SHARPS: Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLATS: Step[] = ["B", "E", "A", "D", "G", "C", "F"];

export function keyAlter(fifths: number, step: Step): number {
  if (fifths > 0) return SHARPS.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLATS.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

export type TimeSignature = { beats: number; beatType: number };

export function parseTime(text: string): TimeSignature | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  if (!match) return null;
  const beats = Number(match[1]);
  const beatType = Number(match[2]);
  if (beats < 1 || ![1, 2, 4, 8, 16, 32].includes(beatType)) return null;
  return { beats, beatType };
}

export function formatTime(time: TimeSignature): string {
  return `${time.beats}/${time.beatType}`;
}

/** Length of a full bar in quarter notes. 6/8 is 3 quarters. */
export function measureQuarters(time: TimeSignature): Rational {
  return r(time.beats * 4, time.beatType);
}

/** Length of one beat in quarter notes. In 6/8 a beat is an eighth. */
export function quartersPerBeat(time: TimeSignature): Rational {
  return r(4, time.beatType);
}

export type Clef = "treble" | "bass" | "alto" | "tenor";

export function parseClef(name: string): Clef | null {
  if (name === "treble" || name === "bass" || name === "alto" || name === "tenor") return name;
  return null;
}

export function clefSign(clef: Clef): { sign: string; line: number } {
  switch (clef) {
    case "treble":
      return { sign: "G", line: 2 };
    case "bass":
      return { sign: "F", line: 4 };
    case "alto":
      return { sign: "C", line: 3 };
    case "tenor":
      return { sign: "C", line: 4 };
  }
}
