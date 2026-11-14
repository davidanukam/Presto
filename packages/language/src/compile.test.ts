import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_NAMES, PRELUDE, builtinHelp, compile } from "./index";

describe("language spec", () => {
  it("documents every builtin", () => {
    const markdown = readFileSync("docs/language.md", "utf8");
    const help = builtinHelp(markdown);
    for (const name of BUILTIN_NAMES) {
      expect(help[name], name).toBeTruthy();
    }
  });
});

describe("compile", () => {
  it("compiles First Notes", () => {
    const source = readFileSync("examples/first-notes.presto", "utf8");
    const result = compile(source);
    expect(result.errors).toEqual([]);
    expect(result.score?.title).toBe("First Notes");
    expect(result.score?.tempo).toBe(96);
    const measures = result.score!.parts[0]!.measures;
    expect(measures).toHaveLength(2);
    const first = measures[0]!.staves[0]!.voices[0]!.events;
    expect(first.map((event) => (event.kind === "note" ? event.pitches[0]!.step : "r"))).toEqual(["C", "E", "G", "B"]);
    expect(result.timeline!.events).toHaveLength(5);
    expect(result.timeline!.events[0]!.midi).toBe(60);
  });

  it("refuses a 5 beat bar", () => {
    const result = compile('notes("c4 d4 e4 f4 g4 |")\n');
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toBe("measure 1 is 5 beats long, time is 4/4");
  });

  it("keeps sticky durations and octaves", () => {
    const result = compile('time("2/4")\nnotes("c4/8 e g/4 |")\n');
    expect(result.ok).toBe(true);
    const events = result.score!.parts[0]!.measures[0]!.staves[0]!.voices[0]!.events;
    expect(events.map((event) => event.duration)).toEqual([
      { n: 1, d: 2 },
      { n: 1, d: 2 },
      { n: 1, d: 1 },
    ]);
    expect(events[1]).toMatchObject({ kind: "note", pitches: [{ step: "E", octave: 4 }] });
  });

  it("spells G major accidentals and writes a tune", () => {
    const source = readFileSync("examples/little-tune.presto", "utf8");
    const result = compile(source);
    expect(result.errors).toEqual([]);
    expect(result.score!.parts[0]!.measures).toHaveLength(4);
    const tied = result.score!.parts[0]!.measures[1]!.staves[0]!.voices[0]!.events[0];
    expect(tied).toMatchObject({ kind: "note", tieStart: true });
  });

  it("builds a grand staff", () => {
    const result = compile(readFileSync("examples/two-hands.presto", "utf8"));
    expect(result.errors).toEqual([]);
    const part = result.score!.parts[0]!;
    expect(part.staffCount).toBe(2);
    expect(part.measures[0]!.staves).toHaveLength(2);
    expect(result.timeline!.events.map((event) => event.midi).sort((a, b) => a - b)).toEqual([48, 52, 55, 64, 67, 72]);
  });

  it("unrolls a motif and plays a repeat twice", () => {
    const result = compile(readFileSync("examples/motif.presto", "utf8"));
    expect(result.errors).toEqual([]);
    expect(result.score!.parts[0]!.measures).toHaveLength(5);
    expect(result.score!.parts[0]!.measures[2]!.repeat?.left).toBe(true);
    expect(result.timeline!.durationBeat).toEqual({ n: 24, d: 1 });
  });

  it("stops a runaway loop", () => {
    const result = compile("for n in range(1000000):\n    n\n");
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toMatch(/limit/i);
  });

  it("transposes C up a minor third to E-flat", () => {
    const result = compile(`${PRELUDE}\nnotes(chord("c4", "minor") + "/1 |")\n`);
    expect(result.errors).toEqual([]);
    const chord = result.score!.parts[0]!.measures[0]!.staves[0]!.voices[0]!.events[0];
    expect(chord).toMatchObject({
      kind: "note",
      pitches: [
        { step: "C", alter: 0, octave: 4 },
        { step: "E", alter: -1, octave: 4 },
        { step: "G", alter: 0, octave: 4 },
      ],
    });
  });

  it("puts a scale into one bar", () => {
    const result = compile(`${PRELUDE}\nnotes(scale("c4", "major") + " |")\n`);
    expect(result.errors).toEqual([]);
    expect(result.score!.parts[0]!.measures[0]!.staves[0]!.voices[0]!.events).toHaveLength(8);
  });

  it("marks dynamics and shortens staccato", () => {
    const result = compile(readFileSync("examples/marked.presto", "utf8"));
    expect(result.errors).toEqual([]);
    const events = result.timeline!.events;
    const loud = events.find((event) => event.midi === 60);
    const staccato = events.find((event) => event.midi === 67);
    expect(loud!.velocity).toBeGreaterThan(70);
    expect(staccato!.durationBeat.n / staccato!.durationBeat.d).toBeCloseTo(0.5);
  });
});
