import {
  chooseDivisions,
  clefSign,
  eq,
  formatRational,
  keyAlter,
  measureQuarters,
  pitchName,
  r,
  toTicks,
  type Clef,
  type Measure,
  type NoteEvent,
  type Part,
  type Pitch,
  type Rational,
  type Score,
  type ScoreEvent,
  type Step,
} from "@presto/score";

const TYPE_NAMES: [Rational, string][] = [
  [r(4), "whole"],
  [r(2), "half"],
  [r(1), "quarter"],
  [r(1, 2), "eighth"],
  [r(1, 4), "16th"],
  [r(1, 8), "32nd"],
];

export const SOUND_PROGRAMS: Record<string, number> = {
  piano: 1,
  violin: 41,
  viola: 42,
  cello: 43,
  flute: 74,
  oboe: 69,
  clarinet: 72,
  bassoon: 71,
  trumpet: 57,
  horn: 61,
  trombone: 58,
  tuba: 59,
  guitar: 25,
  organ: 20,
};

export function scoreToMusicxml(score: Score): string {
  const durations = score.parts.flatMap((part) =>
    part.measures.flatMap((measure) => measure.staves.flatMap((staff) => staff.voices.flatMap((voice) => voice.events.map((event) => event.duration)))),
  );
  const divisions = chooseDivisions(durations.length ? durations : [r(1)]);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<score-partwise version="4.0">');
  lines.push("  <work>");
  lines.push(`    <work-title>${esc(score.title || "Untitled")}</work-title>`);
  lines.push("  </work>");
  lines.push("  <identification>");
  if (score.composer) lines.push(`    <creator type="composer">${esc(score.composer)}</creator>`);
  lines.push("    <encoding><software>Presto</software></encoding>");
  lines.push("  </identification>");
  lines.push("  <part-list>");
  for (const part of score.parts) {
    const program = SOUND_PROGRAMS[part.sound] ?? 1;
    lines.push(`    <score-part id="${part.id}">`);
    lines.push(`      <part-name>${esc(part.name)}</part-name>`);
    lines.push(`      <score-instrument id="${part.id}-I1"><instrument-name>${esc(part.sound)}</instrument-name></score-instrument>`);
    lines.push(`      <midi-instrument id="${part.id}-I1"><midi-channel>1</midi-channel><midi-program>${program}</midi-program></midi-instrument>`);
    lines.push("    </score-part>");
  }
  lines.push("  </part-list>");
  for (const part of score.parts) writePart(lines, score, part, divisions);
  lines.push("</score-partwise>");
  return lines.join("\n");
}

function writePart(lines: string[], score: Score, part: Part, divisions: number) {
  lines.push(`  <part id="${part.id}">`);
  part.measures.forEach((measure, index) => {
    lines.push(`    <measure number="${measure.number}">`);
    writeBarlines(lines, measure, "left");
    if (measure.systemBreak || measure.pageBreak) {
      const attrs = [
        measure.systemBreak ? 'new-system="yes"' : "",
        measure.pageBreak ? 'new-page="yes"' : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`      <print ${attrs}/>`);
    }
    writeAttributes(lines, score, part, measure, index, divisions);
    if (measure.tempo) {
      lines.push(
        `      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${measure.tempo}</per-minute></metronome></direction-type><sound tempo="${measure.tempo}"/></direction>`,
      );
    }
    writeVoices(lines, score, measure, index, divisions);
    writeBarlines(lines, measure, "right");
    lines.push("    </measure>");
  });
  lines.push("  </part>");
}

function writeAttributes(lines: string[], score: Score, part: Part, measure: Measure, index: number, divisions: number) {
  const bits: string[] = [];
  if (index === 0) bits.push(`<divisions>${divisions}</divisions>`);
  if (measure.key) bits.push(`<key><fifths>${measure.key.fifths}</fifths></key>`);
  if (measure.time) {
    bits.push(`<time><beats>${measure.time.beats}</beats><beat-type>${measure.time.beatType}</beat-type></time>`);
  }
  if (index === 0 && part.staffCount > 1) bits.push(`<staves>${part.staffCount}</staves>`);
  for (const clef of measure.clefs ?? []) {
    const sign = clefSign(clef.clef);
    const number = part.staffCount > 1 ? ` number="${clef.staff}"` : "";
    bits.push(`<clef${number}><sign>${sign.sign}</sign><line>${sign.line}</line></clef>`);
  }
  if (!bits.length) return;
  lines.push(`      <attributes>${bits.join("")}</attributes>`);
  void score;
}

function writeVoices(lines: string[], score: Score, measure: Measure, index: number, divisions: number) {
  const length = index === 0 && score.pickup ? score.pickup : measureQuarters(measure.time ?? score.time);
  const full = toTicks(length, divisions);
  let written = false;
  let cursor = 0;
  const fifths = measure.key?.fifths ?? score.key.fifths;
  for (const staff of measure.staves) {
    for (const voice of staff.voices) {
      if (written && cursor > 0) {
        lines.push(`      <backup><duration>${cursor}</duration></backup>`);
        cursor = 0;
      }
      const state = new Map<string, number>();
      const xmlVoice = String((staff.staff - 1) * 4 + voice.voice);
      for (const event of voice.events) {
        cursor += writeEvent(lines, event, staff.staff, xmlVoice, divisions, fifths, state, measure.staves.length > 1 || score.parts.some((part) => part.staffCount > 1));
      }
      written = true;
      if (cursor < full && voice.events.length === 0) cursor = full;
    }
  }
}

function writeEvent(
  lines: string[],
  event: ScoreEvent,
  staff: number,
  voice: string,
  divisions: number,
  fifths: number,
  state: Map<string, number>,
  multiStaff: boolean,
): number {
  const ticks = toTicks(event.duration, divisions);
  if (event.kind === "rest") {
    lines.push(noteXml({
      rest: true,
      ticks,
      event,
      voice,
      staff,
      multiStaff,
    }));
    return ticks;
  }
  if (event.dynamic) {
    lines.push(
      `      <direction placement="below"><direction-type><dynamics><${event.dynamic}/></dynamics></direction-type>${multiStaff ? `<staff>${staff}</staff>` : ""}</direction>`,
    );
  }
  if (event.wedgeStart) {
    lines.push(
      `      <direction><direction-type><wedge type="${event.wedgeStart}"/></direction-type>${multiStaff ? `<staff>${staff}</staff>` : ""}</direction>`,
    );
  }
  event.pitches.forEach((pitch, index) => {
    lines.push(noteXml({
      rest: false,
      pitch,
      chord: index > 0,
      ticks,
      event,
      voice,
      staff,
      multiStaff,
      accidental: accidentalFor(pitch, fifths, state),
    }));
  });
  if (event.wedgeStop) {
    lines.push(
      `      <direction><direction-type><wedge type="stop"/></direction-type>${multiStaff ? `<staff>${staff}</staff>` : ""}</direction>`,
    );
  }
  return ticks;
}

function accidentalFor(pitch: Pitch, fifths: number, state: Map<string, number>): string | null {
  const key = `${pitch.step}${pitch.octave}`;
  const current = state.get(key) ?? keyAlter(fifths, pitch.step as Step);
  if (pitch.alter === current) return null;
  state.set(key, pitch.alter);
  if (pitch.alter === 0) return "natural";
  if (pitch.alter === 1) return "sharp";
  if (pitch.alter === 2) return "double-sharp";
  if (pitch.alter === -1) return "flat";
  if (pitch.alter === -2) return "flat-flat";
  return null;
}

function noteXml(input: {
  rest: boolean;
  pitch?: Pitch;
  chord?: boolean;
  ticks: number;
  event: ScoreEvent;
  voice: string;
  staff: number;
  multiStaff: boolean;
  accidental?: string | null;
}): string {
  const id = input.event.span ? ` id="n${input.event.span.start}-${input.event.span.end}"` : "";
  const parts: string[] = [`<note${id}>`];
  if (input.chord) parts.push("<chord/>");
  if (input.rest) parts.push("<rest/>");
  else if (input.pitch) {
    parts.push("<pitch>");
    parts.push(`<step>${input.pitch.step}</step>`);
    if (input.pitch.alter) parts.push(`<alter>${input.pitch.alter}</alter>`);
    parts.push(`<octave>${input.pitch.octave}</octave>`);
    parts.push("</pitch>");
  }
  parts.push(`<duration>${input.ticks}</duration>`);
  if (input.event.kind === "note" && input.event.tieStop) parts.push('<tie type="stop"/>');
  if (input.event.kind === "note" && input.event.tieStart) parts.push('<tie type="start"/>');
  parts.push(`<voice>${input.voice}</voice>`);
  parts.push(`<type>${noteType(input.event.base)}</type>`);
  for (let dot = 0; dot < input.event.dots; dot++) parts.push("<dot/>");
  if (input.accidental) parts.push(`<accidental>${input.accidental}</accidental>`);
  if (input.event.tuplet) {
    parts.push(
      `<time-modification><actual-notes>${input.event.tuplet.actual}</actual-notes><normal-notes>${input.event.tuplet.normal}</normal-notes></time-modification>`,
    );
  }
  if (input.multiStaff) parts.push(`<staff>${input.staff}</staff>`);
  const notations = notationsOf(input.event, Boolean(input.chord));
  if (notations) parts.push(notations);
  if (!input.rest && input.event.kind === "note" && input.event.lyric && !input.chord) {
    parts.push(`<lyric number="1"><syllabic>single</syllabic><text>${esc(input.event.lyric)}</text></lyric>`);
  }
  parts.push("</note>");
  return `      ${parts.join("")}`;
}

function notationsOf(event: ScoreEvent, chord: boolean): string | null {
  if (chord || event.kind !== "note") {
    if (event.tuplet && (event.tupletStart || event.tupletStop) && !chord) {
      return `<notations>${tupletXml(event)}</notations>`;
    }
    return null;
  }
  const bits: string[] = [];
  if (event.tieStart) bits.push('<tied type="start"/>');
  if (event.tieStop) bits.push('<tied type="stop"/>');
  if (event.tupletStart) bits.push('<tuplet type="start" bracket="yes"/>');
  if (event.tupletStop) bits.push('<tuplet type="stop"/>');
  if (event.slurStart) bits.push('<slur type="start" number="1"/>');
  if (event.slurStop) bits.push('<slur type="stop" number="1"/>');
  for (const art of event.articulations) {
    bits.push(`<articulations><${art}/></articulations>`);
  }
  return bits.length ? `<notations>${bits.join("")}</notations>` : null;
}

function tupletXml(event: ScoreEvent): string {
  const bits: string[] = [];
  if (event.tupletStart) bits.push('<tuplet type="start" bracket="yes"/>');
  if (event.tupletStop) bits.push('<tuplet type="stop"/>');
  return bits.join("");
}

function writeBarlines(lines: string[], measure: Measure, where: "left" | "right") {
  const repeat = measure.repeat;
  if (!repeat) return;
  if (where === "left" && (repeat.left || repeat.endingStart)) {
    const bits: string[] = [];
    if (repeat.left) bits.push("<bar-style>heavy-light</bar-style>", '<repeat direction="forward"/>');
    if (repeat.endingStart && repeat.ending) bits.push(`<ending number="${repeat.ending}" type="start"/>`);
    if (bits.length) lines.push(`      <barline location="left">${bits.join("")}</barline>`);
  }
  if (where === "right" && (repeat.right || repeat.endingStop)) {
    const bits: string[] = ["<bar-style>light-heavy</bar-style>"];
    if (repeat.endingStop && repeat.ending) bits.push(`<ending number="${repeat.ending}" type="stop"/>`);
    if (repeat.right) bits.push('<repeat direction="backward"/>');
    lines.push(`      <barline location="right">${bits.join("")}</barline>`);
  }
}

function noteType(base: Rational): string {
  const found = TYPE_NAMES.find(([value]) => eq(value, base));
  if (!found) throw new Error(`no note type for ${formatRational(base)}`);
  return found[1];
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function pitchText(pitch: Pitch): string {
  return pitchName(pitch);
}
