import type { DynamicName, Measure, NoteEvent, Part, Score, ScoreEvent, SourceSpan } from "./model";
import { DYNAMIC_VELOCITY } from "./model";
import { measureQuarters } from "./pitch";
import {
  add,
  cmp,
  eq,
  isZero,
  mul,
  r,
  sub,
  toNumber,
  ZERO,
  type Rational,
} from "./rational";

export type TimelineEvent = {
  partId: string;
  partName: string;
  sound: string;
  gain: number;
  midi: number;
  startBeat: Rational;
  durationBeat: Rational;
  /** Written sounding length before staccato or slur overlap. */
  writtenBeat: Rational;
  startSeconds: number;
  durationSeconds: number;
  velocity: number;
  span?: SourceSpan;
};

export type TempoPoint = { at: Rational; bpm: number };

export type Timeline = {
  events: TimelineEvent[];
  durationBeat: Rational;
  durationSeconds: number;
  tempo: TempoPoint[];
  /** How many times each written measure is visited, for tests. */
  visits: number[];
};

export function secondsAt(beat: Rational, points: TempoPoint[]): number {
  if (points.length === 0 || cmp(beat, ZERO) <= 0) return 0;
  let seconds = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (cmp(beat, point.at) <= 0) break;
    const next = points[i + 1];
    const segEnd = next && cmp(next.at, beat) < 0 ? next.at : beat;
    const quarters = sub(segEnd, point.at);
    seconds += toNumber(quarters) * (60 / point.bpm);
  }
  return seconds;
}

export function expandMeasures(measures: Measure[]): number[] {
  const out: number[] = [];
  const plays = new Map<number, number>();
  let index = 0;
  let guard = 0;
  while (index < measures.length && guard++ < 100000) {
    const measure = measures[index]!;
    const repeat = measure.repeat;
    if (repeat?.ending != null && repeat.repeatId != null) {
      const pass = (plays.get(repeat.repeatId) ?? 0) + 1;
      const maxEnding = maxEndingFor(measures, repeat.repeatId);
      const wanted = pass > maxEnding ? maxEnding : pass;
      if (repeat.ending !== wanted) {
        index += 1;
        continue;
      }
    }
    out.push(index);
    if (repeat?.right && repeat.repeatId != null && repeat.jumpTo != null) {
      const count = (plays.get(repeat.repeatId) ?? 0) + 1;
      plays.set(repeat.repeatId, count);
      const times = repeat.times ?? 2;
      if (count < times) {
        index = repeat.jumpTo;
        continue;
      }
    }
    index += 1;
  }
  return out;
}

function maxEndingFor(measures: Measure[], id: number): number {
  let max = 1;
  for (const measure of measures) {
    if (measure.repeat?.repeatId === id && measure.repeat.ending != null) {
      max = Math.max(max, measure.repeat.ending);
    }
  }
  return max;
}

function measureLength(measure: Measure, score: Score, measureIndex: number): Rational {
  if (measureIndex === 0 && score.pickup) return score.pickup;
  return measure.time ? measureQuarters(measure.time) : measureQuarters(score.time);
}

type VoiceWalk = {
  part: Part;
  voiceKey: string;
  events: { event: ScoreEvent; measureIndex: number; localBeat: Rational }[];
};

function walkVoices(score: Score, order: number[]): VoiceWalk[] {
  const map = new Map<string, VoiceWalk>();
  for (const measureIndex of order) {
    for (const part of score.parts) {
      const measure = part.measures[measureIndex];
      if (!measure) continue;
      for (const staff of measure.staves) {
        for (const voice of staff.voices) {
          const key = `${part.id}:${staff.staff}:${voice.voice}`;
          let walk = map.get(key);
          if (!walk) {
            walk = { part, voiceKey: key, events: [] };
            map.set(key, walk);
          }
          let local = ZERO;
          for (const event of voice.events) {
            walk.events.push({ event, measureIndex, localBeat: local });
            local = add(local, event.duration);
          }
        }
      }
    }
  }
  return [...map.values()];
}

function applyExpression(walk: VoiceWalk): Map<ScoreEvent, number> {
  const velocity = new Map<ScoreEvent, number>();
  let current = 80;
  let wedge: { type: "crescendo" | "diminuendo"; items: NoteEvent[] } | null = null;

  const finish = (endVel: number) => {
    if (!wedge || wedge.items.length === 0) {
      wedge = null;
      return;
    }
    const start = velocity.get(wedge.items[0]!) ?? current;
    wedge.items.forEach((note, index) => {
      const t = wedge!.items.length === 1 ? 1 : index / (wedge!.items.length - 1);
      const value = Math.round(start + (endVel - start) * t);
      velocity.set(note, clampVel(value));
    });
    wedge = null;
  };

  for (const step of walk.events) {
    if (step.event.kind !== "note") continue;
    const note = step.event;
    if (note.dynamic) current = DYNAMIC_VELOCITY[note.dynamic as DynamicName];
    let value = current;
    if (note.articulations.includes("accent")) value = clampVel(Math.round(value * 1.2));
    velocity.set(note, value);
    if (note.wedgeStart) {
      finish(current);
      wedge = { type: note.wedgeStart, items: [note] };
    } else if (wedge) {
      wedge.items.push(note);
    }
    if (note.wedgeStop) finish(current);
  }
  if (wedge) {
    const open = wedge;
    const delta = open.type === "crescendo" ? 30 : -30;
    const start = velocity.get(open.items[0]!) ?? current;
    finish(clampVel(start + delta));
  }
  return velocity;
}

function clampVel(value: number): number {
  return Math.max(1, Math.min(127, value));
}

export function buildTimeline(score: Score): Timeline {
  const order = score.parts[0] ? expandMeasures(score.parts[0].measures) : [];
  const tempo: TempoPoint[] = [{ at: ZERO, bpm: score.tempo || 120 }];
  const events: TimelineEvent[] = [];
  const visits = score.parts[0] ? score.parts[0].measures.map(() => 0) : [];
  for (const index of order) visits[index] = (visits[index] ?? 0) + 1;

  const beatAtMeasure: Rational[] = [];
  let cursor = ZERO;
  for (const index of order) {
    beatAtMeasure.push(cursor);
    const measure = score.parts[0]?.measures[index];
    if (measure?.tempo && measure.tempo !== tempo[tempo.length - 1]!.bpm) {
      if (eq(cursor, tempo[tempo.length - 1]!.at)) tempo[tempo.length - 1] = { at: cursor, bpm: measure.tempo };
      else tempo.push({ at: cursor, bpm: measure.tempo });
    }
    cursor = add(cursor, measure ? measureLength(measure, score, index) : ZERO);
  }
  const durationBeat = cursor;

  const walks = walkVoices(score, order);
  const velocities = new Map<string, Map<ScoreEvent, number>>();
  for (const walk of walks) velocities.set(walk.voiceKey, applyExpression(walk));

  let slurOpen = false;
  for (const walk of walks) {
    const velMap = velocities.get(walk.voiceKey)!;
    // Slurs are per voice, so track them here.
    slurOpen = false;
    const measureBeat = new Map<number, Rational>();
    order.forEach((measureIndex, visit) => {
      // beatAtMeasure is aligned with `order`, not with measure index alone.
      // Recompute below per event using a parallel cursor instead.
      void visit;
      void measureIndex;
    });
    void measureBeat;

    // Walk `order` once more in lockstep with this voice's events.
    let eventCursor = 0;
    order.forEach((measureIndex, visit) => {
      const startBeat = beatAtMeasure[visit]!;
      const measure = walk.part.measures[measureIndex];
      const staffVoice = measure?.staves
        .flatMap((staff) => staff.voices.map((voice) => ({ staff, voice })))
        .find(({ staff, voice }) => `${walk.part.id}:${staff.staff}:${voice.voice}` === walk.voiceKey);
      if (!staffVoice) return;
      let local = ZERO;
      for (const event of staffVoice.voice.events) {
        eventCursor += 1;
        if (event.kind === "note") {
          const written = event.duration;
          let played = written;
          if (event.articulations.includes("staccato")) played = mul(written, r(1, 2));
          else if (event.articulations.includes("tenuto")) played = written;
          else played = mul(written, r(92, 100));
          if (event.slurStart) slurOpen = true;
          const insideSlur = slurOpen && !event.slurStop;
          if (event.slurStop) slurOpen = false;
          const onset = add(startBeat, local);
          const startSeconds = secondsAt(onset, tempo);
          let durationSeconds = Math.max(0.03, secondsAt(add(onset, played), tempo) - startSeconds);
          if (insideSlur) durationSeconds *= 1.15;
          const velocity = velMap.get(event) ?? 80;
          for (const pitch of event.pitches) {
            events.push({
              partId: walk.part.id,
              partName: walk.part.name,
              sound: walk.part.sound,
              gain: walk.part.gain,
              midi: midiSafe(pitch),
              startBeat: onset,
              durationBeat: played,
              writtenBeat: written,
              startSeconds,
              durationSeconds,
              velocity,
              span: event.span,
            });
          }
        }
        local = add(local, event.duration);
      }
    });
    void eventCursor;
    void isZero;
  }

  events.sort((a, b) => {
    const byBeat = cmp(a.startBeat, b.startBeat);
    if (byBeat !== 0) return byBeat;
    return a.midi - b.midi;
  });

  return {
    events,
    durationBeat,
    durationSeconds: secondsAt(durationBeat, tempo),
    tempo,
    visits,
  };
}

function midiSafe(pitch: { step: "C" | "D" | "E" | "F" | "G" | "A" | "B"; alter: number; octave: number }): number {
  const semi = [0, 2, 4, 5, 7, 9, 11][["C", "D", "E", "F", "G", "A", "B"].indexOf(pitch.step)]!;
  return (pitch.octave + 1) * 12 + semi + pitch.alter;
}
