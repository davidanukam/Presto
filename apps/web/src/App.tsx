import { builtinHelp, compile, PRELUDE, type CompileResult } from "@presto/language";
import { scoreToMusicxml, musicxmlToScore, scoreToPresto, timelineToMidi } from "@presto/musicxml";
import { Player, type Mixer } from "@presto/playback";
import type { Layout, SourceSpan, Timeline } from "@presto/score";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
const FONT_MIN = 11;
const FONT_MAX = 28;
const FONT_DEFAULT = 14;
const STORAGE_KEY = "presto.workspace";

type Good = { musicxml: string; timeline: Timeline; layout: Layout; title: string };
type Modal = "about" | "examples" | "learn" | null;
type Menu = "file" | "parts" | "settings" | null;
type Tab = { id: string; name: string; source: string; savedSource: string };

function newTab(name: string, source: string, saved = source): Tab {
  return { id: crypto.randomUUID(), name, source, savedSource: saved };
}

function loadWorkspace(): { tabs: Tab[]; activeId: string; fontSize: number; showListen: boolean } {
  const fallback = newTab("untitled.presto", DEFAULT_SOURCE);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as {
        tabs?: Tab[];
        activeId?: string;
        fontSize?: number;
        showListen?: boolean;
      };
      if (data.tabs?.length) {
        return {
          tabs: data.tabs,
          activeId: data.activeId && data.tabs.some((t) => t.id === data.activeId) ? data.activeId : data.tabs[0]!.id,
          fontSize: clamp(data.fontSize ?? FONT_DEFAULT, FONT_MIN, FONT_MAX),
          showListen: data.showListen ?? false,
        };
      }
    }
    const legacy = localStorage.getItem("presto.source");
    if (legacy) {
      const tab = newTab("untitled.presto", legacy);
      return { tabs: [tab], activeId: tab.id, fontSize: FONT_DEFAULT, showListen: false };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { tabs: [fallback], activeId: fallback.id, fontSize: FONT_DEFAULT, showListen: false };
}

export function App() {
  const initial = useMemo(() => loadWorkspace(), []);
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [ready, setReady] = useState(false);
  const [compiled, setCompiled] = useState<CompileResult>(() => compile(activeTabSource(initial.tabs, initial.activeId)));
  const [good, setGood] = useState<Good | null>(null);
  const [played, setPlayed] = useState<SourceSpan[]>([]);
  const [seconds, setSeconds] = useState<number | null>(0);
  const [cueSeconds, setCueSeconds] = useState(0);
  const [listen, setListen] = useState(1);
  const [showListen, setShowListen] = useState(initial.showListen);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [mixer, setMixer] = useState<Mixer>({});
  const [panel, setPanel] = useState<"write" | "print">("write");
  const [modal, setModal] = useState<Modal>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [notice, setNotice] = useState("");
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [editorFocused, setEditorFocused] = useState(false);
  const editorRef = useRef<EditorHandle>(null);
  const playSnapshot = useRef<Good | null>(null);

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;
  const source = active.source;
  const dirty = active.source !== active.savedSource;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = location.hash.startsWith("#p=") ? location.hash.slice(3) : "";
      if (hash) {
        try {
          const text = await decodeShare(hash);
          if (!cancelled) {
            const tab = newTab("shared.presto", text);
            setTabs([tab]);
            setActiveId(tab.id);
          }
        } catch {
          if (!cancelled) setNotice("That link could not be opened.");
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const handle = window.setTimeout(() => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tabs, activeId, fontSize, showListen }),
      );
      localStorage.setItem("presto.source", source);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [tabs, activeId, fontSize, showListen, source, ready]);

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
      } else {
        setGood(null);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [source]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+" || event.key === "-" || event.key === "0")) {
        if (!editorFocused && !editorRef.current?.hasFocus()) return;
        event.preventDefault();
        if (event.key === "0") setFontSize(FONT_DEFAULT);
        else if (event.key === "-" ) setFontSize((size) => clamp(size - 1, FONT_MIN, FONT_MAX));
        else setFontSize((size) => clamp(size + 1, FONT_MIN, FONT_MAX));
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest(".cm-editor, input, textarea, button, [role='dialog']")) return;
      if (event.code === "Space") {
        event.preventDefault();
        void toggleFromCue();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!editorFocused && !editorRef.current?.hasFocus()) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -1 : 1;
      setFontSize((size) => clamp(size + delta, FONT_MIN, FONT_MAX));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [editorFocused]);

  useEffect(() => {
    const close = () => setMenu(null);
    if (!menu) return;
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const parts = compiled.score?.parts ?? [];
  const draft = source.startsWith("# Draft imported from MusicXML");

  const exampleEntries = useMemo(
    () =>
      Object.entries(examples)
        .filter(([path]) => !path.includes("/lessons/"))
        .map(([path, text]) => ({ name: path.split("/").pop()!.replace(".presto", ""), text }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  function patchActive(patch: Partial<Tab>) {
    setTabs((current) => current.map((tab) => (tab.id === activeId ? { ...tab, ...patch } : tab)));
  }

  function setSource(next: string | ((current: string) => string)) {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== activeId) return tab;
        const source = typeof next === "function" ? next(tab.source) : next;
        return { ...tab, source };
      }),
    );
  }

  function confirmDiscard(): boolean {
    if (!dirty) return true;
    return window.confirm("You have unsaved changes. Discard them?");
  }

  function replaceActiveSource(next: string, name?: string) {
    if (!confirmDiscard()) return false;
    stopPlayback();
    patchActive({
      source: next,
      savedSource: next,
      ...(name ? { name } : {}),
    });
    setCueSeconds(0);
    setSeconds(0);
    setPlayed([]);
    return true;
  }

  function addTab(tab: Tab, activate = true) {
    setTabs((current) => [...current, tab]);
    if (activate) setActiveId(tab.id);
  }

  function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    if (tab.source !== tab.savedSource && !window.confirm(`Close ${tab.name} with unsaved changes?`)) return;
    if (tabs.length === 1) {
      const blank = newTab("untitled.presto", "");
      setTabs([blank]);
      setActiveId(blank.id);
      return;
    }
    const index = tabs.findIndex((item) => item.id === id);
    const nextTabs = tabs.filter((item) => item.id !== id);
    setTabs(nextTabs);
    if (activeId === id) {
      const neighbor = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0]!;
      setActiveId(neighbor.id);
    }
  }

  function selectTab(id: string) {
    if (id === activeId) return;
    stopPlayback();
    setActiveId(id);
    setCueSeconds(0);
    setSeconds(0);
    setPlayed([]);
  }

  function onPlayback(time: number, spans: SourceSpan[]) {
    setSeconds(time);
    setPlayed(spans);
    setCueSeconds(time);
    if (time === 0 && spans.length === 0) {
      setPlaying(false);
      setPaused(false);
    }
  }

  async function playFrom(fromSeconds: number) {
    const snapshot = good;
    if (!snapshot) return;
    playSnapshot.current = snapshot;
    setPlaying(true);
    setPaused(false);
    setCueSeconds(fromSeconds);
    await player.play(snapshot.timeline, mixer, listen, onPlayback, fromSeconds);
  }

  async function playFromBeginning() {
    await playFrom(0);
  }

  async function playFromCue() {
    if (player.isPaused) {
      player.resume();
      setPlaying(true);
      setPaused(false);
      return;
    }
    await playFrom(cueSeconds);
  }

  async function toggleFromCue() {
    if (player.isPlaying) {
      pausePlayback();
      return;
    }
    await playFromCue();
  }

  function pausePlayback() {
    if (!player.isPlaying) return;
    player.pause();
    setCueSeconds(player.position);
    setSeconds(player.position);
    setPlaying(false);
    setPaused(true);
  }

  function stopPlayback() {
    player.stop();
    setPlaying(false);
    setPaused(false);
    setCueSeconds(0);
    setSeconds(0);
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
    let text = file.text;
    let name = file.name.endsWith(".presto") ? file.name : file.name.replace(/\.(xml|musicxml)$/i, ".presto");
    if (file.name.endsWith(".xml") || file.name.endsWith(".musicxml")) {
      try {
        const score = musicxmlToScore(file.text);
        text = scoreToPresto(score);
        setNotice("Imported draft. This is a draft.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "MusicXML could not be read.");
        return;
      }
    } else {
      setNotice("");
    }
    addTab(newTab(name || "untitled.presto", text));
  }

  async function saveFile() {
    await saveTextFile(slug(good?.title ?? (active.name.replace(/\.presto$/i, "") || "piece")), source, "presto");
    patchActive({ savedSource: source, name: active.name.endsWith(".presto") ? active.name : `${active.name}.presto` });
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

  function loadExample(text: string, name: string) {
    if (!replaceActiveSource(text, `${name}.presto`)) return;
    setModal(null);
  }

  function loadLesson(text: string, title: string) {
    if (!replaceActiveSource(text, `${slug(title)}.presto`)) return;
    setModal(null);
  }

  return (
    <div className={panel === "print" ? "studio is-printing" : "studio"}>
      {panel === "print" ? (
        <header className="print-bar">
          <button type="button" className="icon-btn" onClick={() => setPanel("write")} title="Back to editor">
            <IconArrowLeft />
            <span>Back to editor</span>
          </button>
          <button type="button" className="icon-btn primary" onClick={() => window.print()} title="Print">
            <IconPrinter />
            <span>Print</span>
          </button>
        </header>
      ) : (
        <header className="topbar">
          <div className="brand">
            <span className="mark">P</span>
            <strong>Presto</strong>
          </div>

          <nav className="main-nav">
            <button className="on" type="button" disabled>
              Write
            </button>
            <button type="button" onClick={() => setModal("examples")}>
              Examples
            </button>
            <button type="button" onClick={() => setModal("learn")}>
              Learn
            </button>
            <button type="button" onClick={() => setPanel("print")}>
              Print
            </button>
            <button type="button" onClick={() => setModal("about")}>
              About
            </button>
          </nav>

          <div className="menus" onClick={(event) => event.stopPropagation()}>
            <Dropdown label="File" open={menu === "file"} onToggle={() => setMenu(menu === "file" ? null : "file")}>
              <button type="button" onClick={() => { setMenu(null); void openFile(); }}>Open</button>
              <button type="button" onClick={() => { setMenu(null); void saveFile(); }}>Save .presto</button>
              <hr />
              <button type="button" disabled={!good} onClick={() => { setMenu(null); void exportXml(); }}>MusicXML</button>
              <button type="button" disabled={!good} onClick={() => { setMenu(null); void exportMidi(); }}>MIDI</button>
              <button type="button" disabled={!good} onClick={() => { setMenu(null); exportSvg(); }}>SVG</button>
              <hr />
              <button type="button" onClick={() => { setMenu(null); void share(); }}>Share link</button>
            </Dropdown>

            <Dropdown label="Parts" open={menu === "parts"} onToggle={() => setMenu(menu === "parts" ? null : "parts")}>
              {(parts.length ? parts : [{ id: "none", name: "No parts yet" }]).map((part) => {
                if (part.id === "none") {
                  return <div key={part.id} className="menu-empty">{part.name}</div>;
                }
                const strip = mixer[part.id] ?? { volume: 0.8, mute: false, solo: false };
                const problems = compiled.errors.filter((error) => error.message.includes(part.name));
                const set = (patch: Partial<Mixer[string]>) =>
                  setMixer((current) => {
                    const next = { ...current, [part.id]: { ...strip, ...patch } };
                    player.setMixer(next);
                    return next;
                  });
                return (
                  <div key={part.id} className="menu-part">
                    <div className="menu-part-head">
                      <span>{part.name}</span>
                      {problems.length ? <em title="Errors mentioning this part">{problems.length}</em> : null}
                    </div>
                    <div className="menu-part-controls">
                      <input
                        aria-label={`${part.name} volume`}
                        title="Part volume"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={strip.volume}
                        onChange={(event) => set({ volume: Number(event.target.value) })}
                      />
                      <button
                        type="button"
                        className={strip.mute ? "on" : ""}
                        title="Mute this part"
                        onClick={() => set({ mute: !strip.mute })}
                      >
                        M
                      </button>
                      <button
                        type="button"
                        className={strip.solo ? "on" : ""}
                        title="Solo this part"
                        onClick={() => set({ solo: !strip.solo })}
                      >
                        S
                      </button>
                    </div>
                  </div>
                );
              })}
            </Dropdown>

            <Dropdown label="Settings" open={menu === "settings"} onToggle={() => setMenu(menu === "settings" ? null : "settings")}>
              <label className="menu-check" title="Playback speed relative to the written tempo">
                <input
                  type="checkbox"
                  checked={showListen}
                  onChange={(event) => setShowListen(event.target.checked)}
                />
                Show playback speed
              </label>
              <div className="menu-hint">Space plays and pauses when the editor is not focused.</div>
              <div className="menu-hint">Ctrl + / − or Ctrl + scroll zooms the editor font.</div>
            </Dropdown>
          </div>

          <div className="transport">
            <IconButton
              title="Play from beginning"
              disabled={!good}
              onClick={() => void playFromBeginning()}
            >
              <IconPlayFromStart />
            </IconButton>
            <IconButton
              title="Play from current spot (Space when editor is not focused)"
              disabled={!good}
              onClick={() => void playFromCue()}
            >
              <IconPlay />
            </IconButton>
            <IconButton title="Pause" disabled={!playing} onClick={pausePlayback}>
              <IconPause />
            </IconButton>
            <IconButton title="Stop" onClick={stopPlayback}>
              <IconStop />
            </IconButton>
            {showListen ? (
              <label className="listen" title="Playback speed. 100% is the written tempo.">
                Speed {Math.round(listen * 100)}%
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={listen}
                  onChange={(event) => setListen(Number(event.target.value))}
                />
              </label>
            ) : null}
            {paused ? <span className="transport-status">Paused</span> : null}
          </div>
        </header>
      )}

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
          <section className="editor-pane">
            <div className={`editor-status ${compiled.errors.length ? "is-error" : "is-ok"}`}>
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
            </div>

            <div className="tab-bar" role="tablist" aria-label="Open files">
              {tabs.map((tab) => {
                const isActive = tab.id === activeId;
                const isDirty = tab.source !== tab.savedSource;
                return (
                  <div key={tab.id} className={`tab ${isActive ? "active" : ""}`} role="tab" aria-selected={isActive}>
                    <button type="button" className="tab-label" onClick={() => selectTab(tab.id)} title={tab.name}>
                      <IconFile />
                      <span>
                        {tab.name}
                        {isDirty ? " •" : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="tab-close"
                      title={`Close ${tab.name}`}
                      onClick={() => closeTab(tab.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="tab-add"
                title="New file"
                onClick={() => addTab(newTab("untitled.presto", ""))}
              >
                +
              </button>
            </div>

            <PrestoEditor
              ref={editorRef}
              source={source}
              errors={compiled.errors}
              help={HELP}
              played={played}
              fontSize={fontSize}
              onChange={setSource}
              onFocusChange={setEditorFocused}
            />
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
              onPick={(span, atSeconds) => {
                editorRef.current?.showSpan(span);
                if (atSeconds == null) return;
                setCueSeconds(atSeconds);
                setSeconds(atSeconds);
                if (player.isPlaying || player.isPaused) player.cue(atSeconds);
                if (player.isPaused) {
                  setPaused(true);
                  setPlaying(false);
                }
              }}
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

      {modal === "about" ? (
        <Modal title="About Presto" onClose={() => setModal(null)}>
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
        </Modal>
      ) : null}

      {modal === "examples" ? (
        <Modal title="Examples" onClose={() => setModal(null)}>
          <div className="modal-list">
            {exampleEntries.map((example) => (
              <button key={example.name} type="button" onClick={() => loadExample(example.text, example.name)}>
                {example.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setSource((current) => (current.includes("def scale") ? current : `${PRELUDE}\n${current}`));
                setModal(null);
              }}
            >
              Insert prelude
            </button>
          </div>
        </Modal>
      ) : null}

      {modal === "learn" ? (
        <Modal title="Learn" onClose={() => setModal(null)}>
          <div className="lesson-list">
            {LESSONS.map((lesson) => (
              <article key={lesson.id}>
                <h3>{lesson.title}</h3>
                <p>{lesson.prose}</p>
                <button type="button" onClick={() => loadLesson(lesson.source, lesson.title)}>
                  Open in the editor
                </button>
              </article>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function activeTabSource(tabs: Tab[], activeId: string): string {
  return tabs.find((tab) => tab.id === activeId)?.source ?? tabs[0]?.source ?? DEFAULT_SOURCE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slug(title: string): string {
  const clean = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return clean || "piece";
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Dropdown({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`dropdown ${open ? "open" : ""}`}>
      <button type="button" className="dropdown-toggle" onClick={onToggle} aria-expanded={open}>
        {label}
        <IconChevron />
      </button>
      {open ? <div className="dropdown-menu">{children}</div> : null}
    </div>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="icon-btn transport-btn" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconPlayFromStart() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M6 5h2v14H6zm4 0v14l11-7z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M6 6h12v12H6z" />
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6z" />
    </svg>
  );
}

function IconPrinter() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18 3H6v4H4a2 2 0 0 0-2 2v6h4v6h12v-6h4V9a2 2 0 0 0-2-2h-2V3zm-2 16H8v-5h8v5zm2-9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM8 5h8v2H8V5z"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M7 10l5 5 5-5z" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1 7V3.5L19.5 9H15z" />
    </svg>
  );
}
