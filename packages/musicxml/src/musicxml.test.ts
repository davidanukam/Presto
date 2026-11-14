import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "@presto/language";
import { midiNoteNumbers, musicxmlToScore, scoreToMusicxml, scoreToPresto, timelineToMidi } from "./index";

describe("musicxml", () => {
  it("writes First Notes and reads it back", () => {
    const result = compile(readFileSync("examples/first-notes.presto", "utf8"));
    const xml = scoreToMusicxml(result.score!);
    expect(xml).toContain("<work-title>First Notes</work-title>");
    expect(xml).toContain("<per-minute>96</per-minute>");
    expect(xml).toContain("<step>B</step>");
    const imported = musicxmlToScore(xml);
    expect(flatten(imported)).toEqual(flatten(result.score!));
    const again = compile(scoreToPresto(imported));
    expect(again.ok).toBe(true);
    expect(flatten(again.score!)).toEqual(flatten(result.score!));
  });

  it("prints a natural in G major and hides the signature sharp", () => {
    const result = compile('key("G")\ntime("2/4")\nnotes("f#4 f4 |")\n');
    const xml = scoreToMusicxml(result.score!);
    expect(xml).toContain("<fifths>1</fifths>");
    expect(xml).toContain("<accidental>natural</accidental>");
    const sharpNote = xml.split("<note").find((chunk) => chunk.includes("<step>F</step><alter>1</alter>"));
    expect(sharpNote).not.toContain("<accidental>");
  });

  it("writes a tuplet as two-thirds of a quarter", () => {
    const result = compile('time("2/4")\nnotes("(3 c4 e4 g4) |")\n');
    expect(result.ok).toBe(true);
    const xml = scoreToMusicxml(result.score!);
    expect(xml).toContain("<actual-notes>3</actual-notes>");
    expect(xml).toContain("<normal-notes>2</normal-notes>");
  });

  it("exports midi pitches from the timeline", () => {
    const result = compile(readFileSync("examples/first-notes.presto", "utf8"));
    const notes = midiNoteNumbers(timelineToMidi(result.timeline!));
    expect(notes).toEqual([60, 64, 67, 71, 72]);
  });

  it("keeps dynamics, parts, and durations through a round trip", () => {
    const result = compile(readFileSync("examples/marked.presto", "utf8"));
    const imported = musicxmlToScore(scoreToMusicxml(result.score!));
    expect(imported.parts.map((part) => part.name)).toEqual(["Piano"]);
    expect(flatten(imported).filter((item) => item.dynamic)).toEqual(
      flatten(result.score!).filter((item) => item.dynamic),
    );
    expect(flatten(imported).map((item) => item.duration)).toEqual(flatten(result.score!).map((item) => item.duration));
  });
});

function flatten(score: ReturnType<typeof musicxmlToScore>) {
  return score.parts.flatMap((part) =>
    part.measures.flatMap((measure) =>
      measure.staves.flatMap((staff) =>
        staff.voices.flatMap((voice) =>
          voice.events.map((event) => ({
            duration: event.duration,
            dynamic: event.kind === "note" ? event.dynamic : undefined,
            pitches: event.kind === "note" ? event.pitches : [],
          })),
        ),
      ),
    ),
  );
}
