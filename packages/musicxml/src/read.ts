import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import {
  durationFromDenom,
  isDynamic,
  pitchName,
  r,
  type Clef,
  type DynamicName,
  type KeySignature,
  type Measure,
  type NoteEvent,
  type Part,
  type Pitch,
  type RestEvent,
  type Score,
  type ScoreEvent,
  type Step,
  type TimeSignature,
  DEFAULT_LAYOUT,
} from "@presto/score";

const FIFTHS_TO_NAME: Record<number, string> = {
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  7: "C#",
  [-1]: "F",
  [-2]: "Bb",
  [-3]: "Eb",
  [-4]: "Ab",
  [-5]: "Db",
  [-6]: "Gb",
  [-7]: "Cb",
};

export function musicxmlToScore(xml: string): Score {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.getElementsByTagName("score-partwise")[0];
  if (!root) throw new Error("that file is not a MusicXML score");
  const title = childText(root, "work", "work-title") || "Untitled";
  const composer = composerOf(root);
  const metas = elements(element(root, "part-list"), "score-part");
  let time: TimeSignature = { beats: 4, beatType: 4 };
  let key: KeySignature = { name: "C", fifths: 0 };
  let tempo = 120;
  const parts: Part[] = elements(root, "part").map((partEl, index) => {
    const id = partEl.getAttribute("id") || `P${index + 1}`;
    const meta = metas.find((item) => item.getAttribute("id") === id) ?? metas[index];
    const name = meta ? childText(meta, "part-name") || `Part ${index + 1}` : `Part ${index + 1}`;
    const sound = meta ? childText(meta, "score-instrument", "instrument-name") || "piano" : "piano";
    let divisions = 1;
    let staffCount = 1;
    const measures: Measure[] = elements(partEl, "measure").map((measureEl, measureIndex) => {
      const buckets = new Map<string, ScoreEvent[]>();
      let pendingDynamic: DynamicName | undefined;
      let pendingWedge: NoteEvent["wedgeStart"];
      let measureTime: TimeSignature | undefined;
      let measureKey: KeySignature | undefined;
      let measureTempo: number | undefined;
      const clefs: { staff: number; clef: Clef }[] = [];
      for (const node of children(measureEl)) {
        if (node.tagName === "attributes") {
          const divisionText = childText(node, "divisions");
          if (divisionText) divisions = Number(divisionText);
          const beats = childText(node, "time", "beats");
          const beatType = childText(node, "time", "beat-type");
          if (beats && beatType) {
            time = { beats: Number(beats), beatType: Number(beatType) };
            measureTime = time;
          }
          const fifthsText = childText(node, "key", "fifths");
          if (fifthsText) {
            const fifths = Number(fifthsText);
            key = { name: FIFTHS_TO_NAME[fifths] ?? "C", fifths };
            measureKey = key;
          }
          const staves = childText(node, "staves");
          if (staves) staffCount = Math.max(staffCount, Number(staves));
          for (const clefEl of elements(node, "clef")) {
            const staff = Number(clefEl.getAttribute("number") || "1");
            clefs.push({ staff, clef: clefFrom(childText(clefEl, "sign"), Number(childText(clefEl, "line") || "2")) });
            staffCount = Math.max(staffCount, staff);
          }
        } else if (node.tagName === "direction") {
          const perMinute = childText(node, "direction-type", "metronome", "per-minute");
          const soundTempo = element(node, "sound")?.getAttribute("tempo");
          if (perMinute) {
            tempo = Number(perMinute);
            measureTempo = tempo;
          } else if (soundTempo) {
            tempo = Number(soundTempo);
            measureTempo = tempo;
          }
          const dynamics = element(element(node, "direction-type"), "dynamics");
          if (dynamics) {
            for (const child of children(dynamics)) {
              if (isDynamic(child.tagName)) pendingDynamic = child.tagName;
            }
          }
          const wedge = element(element(node, "direction-type"), "wedge");
          const wedgeType = wedge?.getAttribute("type");
          if (wedgeType === "crescendo" || wedgeType === "diminuendo") pendingWedge = wedgeType;
          if (wedgeType === "stop") {
            const last = lastNote(buckets);
            if (last) last.wedgeStop = true;
          }
        } else if (node.tagName === "note") {
          const staff = Number(childText(node, "staff") || "1");
          const voiceRaw = Number(childText(node, "voice") || "1");
          const voice = ((voiceRaw - 1) % 4) + 1;
          staffCount = Math.max(staffCount, staff);
          const keyName = `${staff}:${voice}`;
          const events = buckets.get(keyName) ?? [];
          const ticks = Number(childText(node, "duration") || "0");
          const duration = r(ticks, divisions || 1);
          const dots = elements(node, "dot").length;
          const base = typeToBase(childText(node, "type") || "quarter");
          const actual = childText(node, "time-modification", "actual-notes");
          const normal = childText(node, "time-modification", "normal-notes");
          const tuplet = actual ? { actual: Number(actual), normal: Number(normal || "2") } : undefined;
          if (element(node, "rest") && !element(node, "chord")) {
            events.push({ kind: "rest", duration, base, dots, tuplet });
            buckets.set(keyName, events);
            continue;
          }
          const pitch = readPitch(element(node, "pitch"));
          if (element(node, "chord")) {
            const previous = [...events].reverse().find((event) => event.kind === "note");
            if (previous?.kind === "note" && pitch) previous.pitches.push(pitch);
            continue;
          }
          const note: NoteEvent = {
            kind: "note",
            pitches: pitch ? [pitch] : [],
            duration,
            base,
            dots,
            tuplet,
            articulations: articulationsOf(node),
            tieStart: tieOf(node, "start"),
            tieStop: tieOf(node, "stop"),
            slurStart: slurOf(node, "start"),
            slurStop: slurOf(node, "stop"),
            lyric: childText(node, "lyric", "text") || undefined,
            span: spanOf(node.getAttribute("id")),
          };
          if (pendingDynamic) {
            note.dynamic = pendingDynamic;
            pendingDynamic = undefined;
          }
          if (pendingWedge) {
            note.wedgeStart = pendingWedge;
            pendingWedge = undefined;
          }
          events.push(note);
          buckets.set(keyName, events);
        }
      }
      markTuplets(buckets);
      const staves = [];
      for (let staff = 1; staff <= staffCount; staff++) {
        const voices = [];
        for (let voice = 1; voice <= 4; voice++) {
          const events = buckets.get(`${staff}:${voice}`);
          if (events?.length) voices.push({ voice, events });
        }
        if (voices.length) staves.push({ staff, voices });
      }
      return {
        number: measureIndex + 1,
        time: measureTime,
        key: measureKey,
        clefs: clefs.length ? clefs : undefined,
        tempo: measureTempo,
        staves,
      } satisfies Measure;
    });
    return { id, name, sound, gain: 1, staffCount, measures };
  });
  const opening = parts[0]?.measures.find((measure) => measure.tempo)?.tempo ?? tempo;
  const openingTime = parts[0]?.measures.find((measure) => measure.time)?.time ?? time;
  const openingKey = parts[0]?.measures.find((measure) => measure.key)?.key ?? key;
  return {
    title,
    composer,
    tempo: opening,
    time: openingTime,
    key: openingKey,
    layout: { ...DEFAULT_LAYOUT },
    parts,
  };
}

export function scoreToPresto(score: Score): string {
  const lines: string[] = ["# Draft imported from MusicXML. This is a draft."];
  if (score.title) lines.push(`title(${JSON.stringify(score.title)})`);
  if (score.composer) lines.push(`composer(${JSON.stringify(score.composer)})`);
  lines.push(`tempo(${score.tempo})`);
  lines.push(`time("${score.time.beats}/${score.time.beatType}")`);
  lines.push(`key("${score.key.name}")`);
  lines.push("");
  for (const part of score.parts) {
    lines.push(`with part(${JSON.stringify(part.name)}, staves=${part.staffCount}, sound=${JSON.stringify(part.sound)}):`);
    const seen = new Set<string>();
    for (const measure of part.measures) {
      for (const clef of measure.clefs ?? []) {
        const token = `${clef.staff}:${clef.clef}`;
        if (seen.has(token)) continue;
        seen.add(token);
        if (part.staffCount > 1) lines.push(`    staff(${clef.staff}).clef("${clef.clef}")`);
        else lines.push(`    clef("${clef.clef}")`);
      }
    }
    if (seen.size === 0) lines.push(`    clef("treble")`);
    for (let staff = 1; staff <= part.staffCount; staff++) {
      const voiceNumbers = new Set<number>();
      for (const measure of part.measures) {
        for (const voice of measure.staves.find((item) => item.staff === staff)?.voices ?? []) voiceNumbers.add(voice.voice);
      }
      const voices = [...voiceNumbers].sort((a, b) => a - b);
      for (const voice of voices) {
        const bars = part.measures.map((measure) => {
          const content = measure.staves.find((item) => item.staff === staff)?.voices.find((item) => item.voice === voice);
          return content ? eventsToMini(content.events) : "";
        });
        const body = bars.map((bar) => `    ${bar} |`).join("\n");
        const target =
          part.staffCount > 1 && voices.length > 1
            ? `staff(${staff}).voice(${voice})`
            : part.staffCount > 1
              ? `staff(${staff})`
              : voices.length > 1
                ? `voice(${voice})`
                : "";
        lines.push(`    ${target ? `${target}.notes` : "notes"}("""`);
        lines.push(body);
        lines.push(`    """)`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function eventsToMini(events: ScoreEvent[]): string {
  let sticky = "";
  return events
    .map((event) => {
      const denom = String((4 * event.base.d) / event.base.n);
      const dots = ".".repeat(event.dots);
      const token = `${denom}${dots}`;
      const dur = token === sticky ? "" : `/${denom}${dots}`;
      sticky = token;
      if (event.kind === "rest") return `r${dur}`;
      const dynamic = event.dynamic ? `${event.dynamic} ` : "";
      const names = event.pitches.map((pitch) => pitchName(pitch));
      const head = names.length > 1 ? `<${names.join(" ")}>${dur}` : `${names[0]}${dur}`;
      const tie = event.tieStart ? "~" : "";
      const arts = event.articulations.length ? ` ${event.articulations.join(" ")}` : "";
      const lyric = event.lyric ? ` "${event.lyric}"` : "";
      return `${dynamic}${head}${tie}${arts}${lyric}`;
    })
    .join(" ");
}

function lastNote(buckets: Map<string, ScoreEvent[]>): NoteEvent | undefined {
  for (const events of buckets.values()) {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === "note") return event;
    }
  }
  return undefined;
}

function markTuplets(buckets: Map<string, ScoreEvent[]>) {
  for (const events of buckets.values()) {
    events.forEach((event, index) => {
      if (!event.tuplet) return;
      const prev = events[index - 1];
      if (!prev?.tuplet) event.tupletStart = true;
      const next = events[index + 1];
      if (!next?.tuplet) event.tupletStop = true;
    });
  }
}

function readPitch(pitch: XmlElement | undefined): Pitch | null {
  if (!pitch) return null;
  const step = childText(pitch, "step").toUpperCase();
  if (!["C", "D", "E", "F", "G", "A", "B"].includes(step)) return null;
  return {
    step: step as Step,
    alter: Number(childText(pitch, "alter") || "0"),
    octave: Number(childText(pitch, "octave") || "4"),
  };
}

function articulationsOf(note: XmlElement): NoteEvent["articulations"] {
  const names: NoteEvent["articulations"] = [];
  for (const art of elements(element(note, "notations"), "articulations")) {
    for (const child of children(art)) {
      if (child.tagName === "staccato" || child.tagName === "accent" || child.tagName === "tenuto") names.push(child.tagName);
    }
  }
  return names;
}

function tieOf(note: XmlElement, type: string): boolean {
  if (elements(note, "tie").some((tie) => tie.getAttribute("type") === type)) return true;
  return elements(element(note, "notations"), "tied").some((tie) => tie.getAttribute("type") === type);
}

function slurOf(note: XmlElement, type: string): boolean {
  return elements(element(note, "notations"), "slur").some((slur) => slur.getAttribute("type") === type);
}

function spanOf(id: string | null): { start: number; end: number } | undefined {
  const match = /^n(\d+)-(\d+)$/.exec(id ?? "");
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function typeToBase(typeName: string) {
  const table: Record<string, number> = { whole: 1, half: 2, quarter: 4, eighth: 8, "16th": 16, "32nd": 32 };
  return durationFromDenom(table[typeName] ?? 4, 0).base;
}

function clefFrom(sign: string, line: number): Clef {
  if (sign === "F") return "bass";
  if (sign === "C" && line === 3) return "alto";
  if (sign === "C") return "tenor";
  return "treble";
}

function composerOf(root: XmlElement): string {
  const creators = elements(element(root, "identification"), "creator");
  const composer = creators.find((item) => item.getAttribute("type") === "composer") ?? creators[0];
  return composer?.textContent?.trim() ?? "";
}

function element(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const child of children(parent)) if (child.tagName === name) return child;
  return undefined;
}

function elements(parent: XmlElement | undefined, name: string): XmlElement[] {
  if (!parent) return [];
  return children(parent).filter((child) => child.tagName === name);
}

function children(parent: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let index = 0; index < parent.childNodes.length; index++) {
    const node = parent.childNodes[index];
    if (node && node.nodeType === 1) out.push(node as XmlElement);
  }
  return out;
}

function childText(parent: XmlElement | undefined, ...path: string[]): string {
  let current = parent;
  for (const name of path) {
    current = element(current, name);
    if (!current) return "";
  }
  return current?.textContent?.trim() ?? "";
}
