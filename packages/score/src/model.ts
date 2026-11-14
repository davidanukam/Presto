import type { Clef, KeySignature, Pitch, TimeSignature } from "./pitch";
import type { Rational } from "./rational";

export type SourceSpan = { start: number; end: number };

export type DynamicName = "ppp" | "pp" | "p" | "mp" | "mf" | "f" | "ff" | "fff";

export const DYNAMIC_VELOCITY: Record<DynamicName, number> = {
  ppp: 16,
  pp: 33,
  p: 49,
  mp: 64,
  mf: 80,
  f: 96,
  ff: 112,
  fff: 127,
};

export const DYNAMIC_NAMES = Object.keys(DYNAMIC_VELOCITY) as DynamicName[];

export function isDynamic(word: string): word is DynamicName {
  return Object.prototype.hasOwnProperty.call(DYNAMIC_VELOCITY, word);
}

export type Articulation = "staccato" | "accent" | "tenuto";

export function isArticulation(word: string): word is Articulation {
  return word === "staccato" || word === "accent" || word === "tenuto";
}

export type Tuplet = { actual: number; normal: number };

export type NoteEvent = {
  kind: "note";
  pitches: Pitch[];
  /** Sounding length in quarter notes, after dots and tuplets. */
  duration: Rational;
  /** Undotted, pre-tuplet length in quarter notes. A quarter is 1. */
  base: Rational;
  dots: number;
  tuplet?: Tuplet;
  tupletStart?: boolean;
  tupletStop?: boolean;
  tieStart?: boolean;
  tieStop?: boolean;
  articulations: Articulation[];
  /** Printed only where the dynamic changes. */
  dynamic?: DynamicName;
  lyric?: string;
  slurStart?: boolean;
  slurStop?: boolean;
  wedgeStart?: "crescendo" | "diminuendo";
  wedgeStop?: boolean;
  span?: SourceSpan;
};

export type RestEvent = {
  kind: "rest";
  duration: Rational;
  base: Rational;
  dots: number;
  tuplet?: Tuplet;
  tupletStart?: boolean;
  tupletStop?: boolean;
  span?: SourceSpan;
};

export type ScoreEvent = NoteEvent | RestEvent;

export type VoiceContent = {
  voice: number;
  events: ScoreEvent[];
};

export type StaffContent = {
  staff: number;
  voices: VoiceContent[];
};

export type RepeatMark = {
  left?: boolean;
  right?: boolean;
  times?: number;
  /** Measure index to jump back to. */
  jumpTo?: number;
  ending?: number;
  endingStart?: boolean;
  endingStop?: boolean;
  repeatId?: number;
};

export type Measure = {
  number: number;
  time?: TimeSignature;
  key?: KeySignature;
  clefs?: { staff: number; clef: Clef }[];
  tempo?: number;
  staves: StaffContent[];
  repeat?: RepeatMark;
  systemBreak?: boolean;
  pageBreak?: boolean;
};

export type Part = {
  id: string;
  name: string;
  sound: string;
  /** Written gain from `gain()`, from 0 to 1. Mixer faders are separate. */
  gain: number;
  staffCount: number;
  measures: Measure[];
};

export type Layout = {
  page: "A4" | "Letter";
  margin: number;
  musicTop: number;
  musicBottom: number;
  staffDistance: number;
  grandStaffDistance: number;
  minSystemDistance: number;
  maxSystemDistance: number;
};

export const DEFAULT_LAYOUT: Layout = {
  page: "A4",
  margin: 12,
  musicTop: 10,
  musicBottom: 10,
  staffDistance: 8,
  grandStaffDistance: 10,
  minSystemDistance: 12,
  maxSystemDistance: 24,
};

export type Score = {
  title: string;
  composer: string;
  tempo: number;
  time: TimeSignature;
  key: KeySignature;
  pickup?: Rational;
  layout: Layout;
  parts: Part[];
};

export function cloneLayout(layout: Layout = DEFAULT_LAYOUT): Layout {
  return { ...layout };
}
