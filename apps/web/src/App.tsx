import { builtinHelp, compile, PRELUDE, type CompileResult } from "@presto/language";
import { scoreToMusicxml, musicxmlToScore, scoreToPresto, timelineToMidi } from "@presto/musicxml";
import { Player, type Mixer } from "@presto/playback";
import type { Layout, SourceSpan, Timeline } from "@presto/score";
import { useEffect, useMemo, useRef, useState } from "react";
import spec from "../../../docs/language.md?raw";
import { PrestoEditor, type EditorHandle } from "./editor";
import { openTextFile, saveBinaryFile, saveTextFile } from "./files";
import { LESSONS } from "./lessons";
import { ScoreView } from "./score-view";
import { decodeShare, encodeShare } from "./share";

const examples = import.meta.glob("../../../examples/**/*.presto", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const HELP = builtinHelp(spec);
const player = new Player();

const DEFAULT_SOURCE = examples["../../../examples/first-notes.presto"] ?? LESSONS[0]!.source;

type Good = { musicxml: string; timeline: Timeline; layout: Layout; title: string };

export function App() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [ready, setReady] = useState(false);
  const [compiled, setCompiled] = useState<CompileResult>(() => compile(DEFAULT_SOURCE));
  const [good, setGood] = useState<Good | null>(null);
  const [played, setPlayed] = useState<SourceSpan[]>([]);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [listen, setListen] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [mixer, setMixer] = useState<Mixer>({});
  const [panel, setPanel] = useState<"write" | "learn" | "print">("write");
  const [about, setAbout] = useState(false);
  const [notice, setNotice] = useState("");
  const editorRef = useRef<EditorHandle>(null);
  const pausedRef = useRef(false);
  const playSnapshot = useRef<Good | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = location.hash.startsWith("#p=") ? location.hash.slice(3) : "";
      if (hash) {
        try {
          const text = await decodeShare(hash);
          if (!cancelled) setSource(text);
        } catch {
          if (!cancelled) setNotice("That link could not be opened.");
        }
      } else {
        const saved = localStorage.getItem("presto.source");
        if (saved) setSource(saved);
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const handle = window.setTimeout(() => localStorage.setItem("presto.source", source), 250);
    return () => window.clearTimeout(handle);
  }, [source, ready]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = compile(source);
      setCompiled(result);
      if (result.ok && result.score && result.timeline) {
        const musicxml = scoreToMusicxml(result.score);
        setGood({
          musicxml,
          timeline: result.timeline,
          layout: result.score.layout,
          title: result.score.title || "Untitled",
        });
        setMixer((current) => {
          const next: Mixer = {};
          for (const part of result.score!.parts) {
            next[part.id] = current[part.id] ?? { volume: 0.8, mute: false, solo: false };
          }
          return next;
        });
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [source]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".cm-editor, input, textarea, button")) return;
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const parts = compiled.score?.parts ?? [];
  const draft = source.startsWith("# Draft imported from MusicXML");

  async function togglePlay() {
    if (player.isPlaying) {
      player.pause();
      pausedRef.current = true;
      setPlaying(false);
      return;
    }
    if (pausedRef.current && good) {
      player.resume();
      pausedRef.current = false;
      setPlaying(true);
      return;
    }
    const snapshot = good;
    if (!snapshot) return;
    playSnapshot.current = snapshot;
    pausedRef.current = false;
    setPlaying(true);
    await player.play(snapshot.timeline, mixer, listen, (time, spans) => {
      setSeconds(time);
      setPlayed(spans);
      if (time === 0 && spans.length === 0) setPlaying(false);
    });
  }

  function stop() {
    pausedRef.current = false;
    player.stop();
    setPlaying(false);
    setSeconds(null);
    setPlayed([]);
  }

  async function share() {
    try {
      const encoded = await encodeShare(source);
      const url = `${location.origin}${location.pathname}#p=${encoded}`;
      history.replaceState(null, "", `#p=${encoded}`);
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "This piece is too big for a link.");
    }
  }

  async function openFile() {
    const file = await openTextFile(["presto", "xml", "musicxml"]);
    if (!file) return;
    if (file.name.endsWith(".xml") || file.name.endsWith(".musicxml")) {
      try {
        const score = musicxmlToScore(file.text);
        setSource(scoreToPresto(score));
        setNotice("Imported draft. This is a draft.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "MusicXML could not be read.");
      }
      return;
    }
    setSource(file.text);
    setNotice("");
  }

  async function saveFile() {
    await saveTextFile(slug(good?.title ?? "piece"), source, "presto");
  }

  async function exportXml() {
    if (!good) return;
    await saveTextFile(slug(good.title), good.musicxml, "musicxml");
  }

  async function exportMidi() {
    if (!good) return;
    await saveBinaryFile(`${slug(good.title)}.mid`, timelineToMidi(good.timeline), "mid", "audio/midi");
  }

  function exportSvg() {
    const svg = document.querySelector(".score-page svg");
    if (!svg || !good) return;
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug(good.title)}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const exampleEntries = useMemo(
    () =>
      Object.entries(examples)
        .filter(([path]) => !path.includes("/lessons/"))
        .map(([path, text]) => ({ name: path.split("/").pop()!.replace(".presto", ""), text }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  return (
    <div className={panel === "print" ? "studio is-printing" : "studio"}>
      <header className="topbar">
        <div className="brand">
          <span className="mark">P</span>
          <div>
            <strong>Presto</strong>
            <small>code in, sheet music out</small>
          </div>
        </div>
        <nav>
          <button className={panel === "write" ? "on" : ""} onClick={() => setPanel("write")} type="button">
            Write
          </button>
          <button className={panel === "learn" ? "on" : ""} onClick={() => setPanel("learn")} type="button">
            Learn
          </button>
          <button className={panel === "print" ? "on" : ""} onClick={() => setPanel("print")} type="button">
            Print
          </button>
          <button onClick={() => setAbout(true)} type="button">
            About
          </button>
        </nav>
        <div className="transport">
          <button type="button" onClick={() => void togglePlay()} disabled={!good}>
            {playing && player.isPlaying ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={stop}>
            Stop
          </button>
          <label>
            Listen {Math.round(listen * 100)}%
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={listen}
              onChange={(event) => setListen(Number(event.target.value))}
            />
          </label>
          <span className="hint">Space plays and pauses when the editor is not focused.</span>
        </div>
      </header>

      {notice ? (
        <div className="notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {draft ? <div className="notice draft">Imported draft. This is a draft, not a perfect copy of the original file.</div> : null}

      <div className="body">
        {panel !== "print" ? (
          <aside>
            {panel === "learn" ? (
              <section>
                <h2>Lessons</h2>
                {LESSONS.map((lesson) => (
                  <article key={lesson.id}>
                    <h3>{lesson.title}</h3>
                    <p>{lesson.prose}</p>
                    <button type="button" onClick={() => setSource(lesson.source)}>
                      Open in the editor
                    </button>
                  </article>
                ))}
              </section>
            ) : (
              <section>
                <h2>Examples</h2>
                {exampleEntries.map((example) => (
                  <button key={example.name} type="button" onClick={() => setSource(example.text)}>
                    {example.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSource((current) => (current.includes("def scale") ? current : `${PRELUDE}\n${current}`))}
                >
                  Insert prelude
                </button>
                <h2>Parts</h2>
                {(parts.length ? parts : [{ id: "none", name: "No parts yet" }]).map((part) => {
                  const problems = compiled.errors.filter((error) => part.name !== "No parts yet" && error.message.includes(part.name));
                  return (
                    <div key={part.id} className="part-row">
                      <span>{part.name}</span>
                      {problems.length ? <em>{problems.length}</em> : null}
                    </div>
                  );
                })}
              </section>
            )}
            <section className="file-actions">
              <button type="button" onClick={() => void openFile()}>
                Open
              </button>
              <button type="button" onClick={() => void saveFile()}>
                Save .presto
              </button>
              <button type="button" onClick={() => void exportXml()} disabled={!good}>
                MusicXML
              </button>
              <button type="button" onClick={() => void exportMidi()} disabled={!good}>
                MIDI
              </button>
              <button type="button" onClick={exportSvg} disabled={!good}>
                SVG
              </button>
              <button type="button" onClick={() => void share()}>
                Share link
              </button>
            </section>
          </aside>
        ) : null}

        {panel !== "print" ? (
          <section className="editor-pane">
            <PrestoEditor
              ref={editorRef}
              source={source}
              errors={compiled.errors}
              help={HELP}
              played={played}
              onChange={setSource}
            />
            {compiled.errors.length ? (
              <ul className="errors">
                {compiled.errors.map((error, index) => (
                  <li key={`${error.line}-${error.column}-${index}`}>
                    Line {error.line}: {error.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ok">Compiled.</p>
            )}
          </section>
        ) : null}

        <section className="score-pane">
          {good ? (
            <ScoreView
              musicxml={good.musicxml}
              layout={good.layout}
              printing={panel === "print"}
              seconds={seconds}
              timeline={playSnapshot.current?.timeline ?? good.timeline}
              onPick={(span) => editorRef.current?.showSpan(span)}
            />
          ) : (
            <div className="empty-score">
              <p>Write a full bar to see the sheet.</p>
              <p>A bar that does not add up stays off the page.</p>
            </div>
          )}
          <p className="credit">Engraved with OpenSheetMusicDisplay (BSD-3-Clause), which draws with VexFlow (MIT).</p>
        </section>
      </div>

      <footer className="mixer">
        {(compiled.ok ? compiled.score?.parts ?? [] : []).map((part) => {
          const strip = mixer[part.id] ?? { volume: 0.8, mute: false, solo: false };
          const set = (patch: Partial<Mixer[string]>) =>
            setMixer((current) => {
              const next = { ...current, [part.id]: { ...strip, ...patch } };
              player.setMixer(next);
              return next;
            });
          return (
            <label key={part.id} className="strip">
              <span>{part.name}</span>
              <input
                aria-label={`${part.name} volume`}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={strip.volume}
                onChange={(event) => set({ volume: Number(event.target.value) })}
              />
              <button type="button" className={strip.mute ? "on" : ""} onClick={() => set({ mute: !strip.mute })}>
                M
              </button>
              <button type="button" className={strip.solo ? "on" : ""} onClick={() => set({ solo: !strip.solo })}>
                S
              </button>
            </label>
          );
        })}
      </footer>

      {about ? (
        <div className="about" role="dialog" aria-label="About Presto">
          <div>
            <h2>About Presto</h2>
            <p>Presto compiles a small Python-like language into a score, a sheet, and a performance.</p>
            <p>Engraved with OpenSheetMusicDisplay (BSD-3-Clause), built on VexFlow (MIT).</p>
            <p>
              Online piano notes use smplr’s Splendid Grand Piano. Other instruments use the FluidR3 soundfont through smplr when
              the network is available. Offline, Presto plays built-in piano tones and simple waveforms.
            </p>
            <p>
              Page size, margins, staff distance, grand-staff distance, and the minimum system distance are sent to the
              engraver. OSMD does not offer a separate maximum system distance; it keeps at least the minimum and then spreads
              systems down the page. Verovio is not bundled, because it does not add that missing maximum either.
            </p>
            <button type="button" onClick={() => setAbout(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function slug(title: string): string {
  const clean = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return clean || "piece";
}
