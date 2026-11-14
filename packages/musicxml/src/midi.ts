import { chooseDivisions, cmp, r, toTicks, type Rational, type Timeline } from "@presto/score";

export function timelineToMidi(timeline: Timeline): Uint8Array {
  const beats = timeline.events.flatMap((event) => [event.startBeat, addBeat(event.startBeat, event.writtenBeat)]);
  const ppq = chooseDivisions(beats.length ? beats : [r(1)]);
  const tracks: Uint8Array[] = [tempoTrack(timeline, ppq)];
  const byPart = new Map<string, Timeline["events"]>();
  for (const event of timeline.events) {
    const list = byPart.get(event.partId) ?? [];
    list.push(event);
    byPart.set(event.partId, list);
  }
  let channel = 0;
  for (const events of byPart.values()) {
    tracks.push(noteTrack(events, ppq, channel % 16));
    channel += 1;
  }
  const header = chunk("MThd", concat([u16(1), u16(tracks.length), u16(Math.min(ppq, 32767))]));
  return concat([header, ...tracks]);
}

function tempoTrack(timeline: Timeline, ppq: number): Uint8Array {
  const events: { tick: number; data: number[] }[] = [];
  for (const point of timeline.tempo) {
    const mpq = Math.round(60_000_000 / point.bpm);
    events.push({
      tick: toTicks(point.at, ppq),
      data: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff],
    });
  }
  events.push({ tick: toTicks(timeline.durationBeat, ppq), data: [0xff, 0x2f, 0x00] });
  return trackChunk(events);
}

function noteTrack(events: Timeline["events"], ppq: number, channel: number): Uint8Array {
  const midi: { tick: number; data: number[]; off: boolean }[] = [];
  for (const event of events) {
    const on = toTicks(event.startBeat, ppq);
    const off = toTicks(addBeat(event.startBeat, event.writtenBeat), ppq);
    midi.push({ tick: on, off: false, data: [0x90 | channel, event.midi, event.velocity] });
    midi.push({ tick: Math.max(off, on + 1), off: true, data: [0x80 | channel, event.midi, 0] });
  }
  midi.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off));
  midi.push({ tick: midi.length ? midi[midi.length - 1]!.tick : 0, off: true, data: [0xff, 0x2f, 0x00] });
  return trackChunk(midi);
}

function trackChunk(events: { tick: number; data: number[] }[]): Uint8Array {
  const bytes: number[] = [];
  let cursor = 0;
  for (const event of events) {
    bytes.push(...vlq(event.tick - cursor));
    bytes.push(...event.data);
    cursor = event.tick;
  }
  return chunk("MTrk", new Uint8Array(bytes));
}

function addBeat(a: Rational, b: Rational): Rational {
  return r(a.n * b.d + b.n * a.d, a.d * b.d);
}

function vlq(value: number): number[] {
  let rest = Math.max(0, value);
  const bytes = [rest & 0x7f];
  rest >>= 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(type), 0);
  new DataView(head.buffer).setUint32(4, data.length);
  return concat([head, data]);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function midiNoteNumbers(bytes: Uint8Array): number[] {
  const notes: number[] = [];
  let index = 14;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackCount = view.getUint16(10);
  index = 14;
  for (let track = 0; track < trackCount; track++) {
    index += 4;
    const length = view.getUint32(index);
    index += 4;
    const end = index + length;
    let running = 0;
    while (index < end) {
      while (bytes[index]! & 0x80) index += 1;
      index += 1;
      const status = bytes[index]!;
      if (status >= 0x80) {
        running = status;
        index += 1;
      }
      if ((running & 0xf0) === 0x90) {
        const note = bytes[index]!;
        const velocity = bytes[index + 1]!;
        if (velocity > 0) notes.push(note);
        index += 2;
      } else if ((running & 0xf0) === 0x80) index += 2;
      else if (running === 0xff) {
        index += 1;
        const size = bytes[index]!;
        index += 1 + size;
      } else index += 2;
    }
  }
  void cmp;
  return notes;
}
