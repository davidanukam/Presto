import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, bracketMatching, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { linter, forceLinting, type Diagnostic } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CompileError } from "@presto/language";
import type { SourceSpan } from "@presto/score";

export type EditorHandle = {
  showSpan: (span: SourceSpan) => void;
  focus: () => void;
  hasFocus: () => boolean;
};

const setPlayed = StateEffect.define<SourceSpan[]>();
const playedMark = Decoration.mark({ class: "cm-played" });
const playedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPlayed)) {
        const ranges = effect.value
          .filter((span) => span.end > span.start)
          .map((span) => playedMark.range(span.start, span.end));
        return Decoration.set(ranges, true);
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const prestoLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match('"""')) {
      while (!stream.eol()) {
        if (stream.match('"""')) return "string";
        stream.next();
      }
      return "string";
    }
    if (stream.match('"')) {
      while (!stream.eol()) {
        if (stream.match('"')) return "string";
        stream.next();
      }
      return "string";
    }
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^(def|for|if|elif|else|with|return|repeat|ending|in|and|or|not|True|False|None)\b/)) return "keyword";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "variableName";
    if (stream.match(/^\d+(\.\d+)?/)) return "number";
    stream.next();
    return null;
  },
});

/** Catppuccin Mocha syntax colors */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#cba6f7", fontStyle: "italic" },
  { tag: tags.comment, color: "#6c7086", fontStyle: "italic" },
  { tag: tags.string, color: "#a6e3a1" },
  { tag: tags.number, color: "#fab387" },
  { tag: tags.variableName, color: "#cdd6f4" },
]);

type Props = {
  source: string;
  errors: CompileError[];
  help: Record<string, string>;
  played: SourceSpan[];
  fontSize: number;
  onChange: (source: string) => void;
  onFocusChange?: (focused: boolean) => void;
};

export const PrestoEditor = forwardRef<EditorHandle, Props>(function PrestoEditor(
  { source, errors, help, played, fontSize, onChange, onFocusChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const errorsRef = useRef(errors);
  const helpRef = useRef(help);
  const onFocusChangeRef = useRef(onFocusChange);
  onChangeRef.current = onChange;
  errorsRef.current = errors;
  helpRef.current = help;
  onFocusChangeRef.current = onFocusChange;

  useImperativeHandle(ref, () => ({
    showSpan(span) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        selection: { anchor: span.start, head: span.end },
        scrollIntoView: true,
      });
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
    hasFocus() {
      return viewRef.current?.hasFocus ?? false;
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      prestoLanguage,
      syntaxHighlighting(highlight),
      playedField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        if (update.focusChanged) onFocusChangeRef.current?.(update.view.hasFocus);
      }),
      hoverTooltip((view, pos) => {
        const word = view.state.wordAt(pos);
        if (!word) return null;
        const text = view.state.sliceDoc(word.from, word.to);
        const body = helpRef.current[text];
        if (!body) return null;
        return {
          pos: word.from,
          end: word.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "hover-help";
            dom.textContent = body;
            return { dom };
          },
        };
      }),
      linter((view) =>
        errorsRef.current.map(
          (error): Diagnostic => ({
            from: Math.min(error.start, view.state.doc.length),
            to: Math.min(Math.max(error.end, error.start + 1), view.state.doc.length),
            severity: "error",
            message: error.message,
          }),
        ),
      ),
    ];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: source, extensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor owns the document after mount. Source resets go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== source) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    }
  }, [source]);

  useEffect(() => {
    if (viewRef.current) forceLinting(viewRef.current);
  }, [errors]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setPlayed.of(played) });
  }, [played]);

  useEffect(() => {
    if (host.current) host.current.style.setProperty("--editor-font-size", `${fontSize}px`);
  }, [fontSize]);

  return <div className="editor-host" ref={host} />;
});
