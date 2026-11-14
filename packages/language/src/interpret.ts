import { parseMini } from "@presto/mini";
import {
  checkBar,
  cloneLayout,
  expectedQuarters,
  parseClef,
  parseKey,
  parseTime,
  r,
  transposeMusic,
  type Clef,
  type DynamicName,
  type KeySignature,
  type Layout,
  type Measure,
  type Part,
  type RepeatMark,
  type Score,
  type ScoreEvent,
  type TimeSignature,
  isArticulation,
  isDynamic,
} from "@presto/score";
import type { ArgExpr, Expr, Span, Stmt } from "./parser";

export const MAX_STEPS = 100_000;
export const MAX_NOTES = 20_000;
export const MAX_CALLS = 500;

export const BUILTIN_NAMES = [
  "title",
  "composer",
  "tempo",
  "time",
  "key",
  "clef",
  "notes",
  "part",
  "staff",
  "voice",
  "pickup",
  "sound",
  "gain",
  "dynamic",
  "articulation",
  "layout",
  "break_system",
  "break_page",
  "crescendo",
  "diminuendo",
  "slur_start",
  "slur_end",
  "wedge_stop",
  "transpose",
  "range",
  "lyric",
] as const;

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
  }
}

class ReturnSignal {
  constructor(readonly value: Val) {}
}

type Val =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "none" }
  | { t: "list"; v: Val[] }
  | { t: "range"; start: number; end: number }
  | { t: "fn"; name: string; params: string[]; body: Stmt[]; env: Env }
  | { t: "part"; index: number }
  | { t: "staff"; index: number; staff: number }
  | { t: "voice"; index: number; staff: number; voice: number };

class Env {
  readonly vars = new Map<string, Val>();
  constructor(readonly parent?: Env) {}
  get(name: string): Val | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }
}

type Seq = {
  staff: number;
  voice: number;
  bars: BarDraft[];
  shownTime?: TimeSignature;
  shownKey?: KeySignature;
  shownClef?: Clef;
};

type BarDraft = {
  events: ScoreEvent[];
  time?: TimeSignature;
  key?: KeySignature;
  clef?: Clef;
  tempo?: number;
  systemBreak?: boolean;
  pageBreak?: boolean;
  markLeft?: boolean;
  markRight?: boolean;
  times?: number;
  jumpTo?: number;
  repeatId?: number;
  ending?: number;
  endingStart?: boolean;
  endingStop?: boolean;
};

type PartDraft = {
  name: string;
  sound: string;
  gain: number;
  staffCount: number;
  clefs: Map<number, Clef>;
  seqs: Seq[];
};

type OpenRepeat = {
  id: number;
  times: number;
  ending?: number;
  sawEnding: boolean;
  leftIndex: Map<string, { seq: Seq; index: number }>;
  lastInRepeat: Map<string, { seq: Seq; index: number }>;
  lastInEnding: Map<string, { seq: Seq; index: number }>;
  endingFirst: Set<string>;
};

type Issue = { message: string; start: number; end: number };

export class Interpreter {
  readonly issues: Issue[] = [];
  private env = new Env();
  private steps = 0;
  private depth = 0;
  private noteCount = 0;
  private title = "";
  private composer = "";
  private tempo = 120;
  private tempoPending = false;
  private time: TimeSignature = { beats: 4, beatType: 4 };
  private key: KeySignature = { name: "C", fifths: 0 };
  private pickup?: ReturnType<typeof r>;
  private layout: Layout = cloneLayout();
  private parts: PartDraft[] = [];
  private partIndex = -1;
  private staff = 1;
  private voice = 1;
  private openingTempo = 120;
  private pendingDynamic?: DynamicName;
  private pendingArts: import("@presto/score").Articulation[] = [];
  private lyricPending?: string;
  private slurStartPending = false;
  private wedgeArm?: "crescendo" | "diminuendo";
  private wedgeOpen = false;
  private pendingBreak?: "system" | "page";
  private repeatStack: OpenRepeat[] = [];
  private nextRepeat = 1;

  constructor(private source: string) {
    for (const name of BUILTIN_NAMES) this.env.vars.set(name, { t: "str", v: name });
  }

  run(body: Stmt[]): Score | null {
    try {
      this.execBlock(body);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        throw new RuntimeError("return is only allowed inside a function", { start: 0, end: 0 });
      }
      throw error;
    }
    return this.finish();
  }

  private execBlock(body: Stmt[]) {
    for (const stmt of body) this.exec(stmt);
  }

  private exec(stmt: Stmt) {
    this.tick(stmt.span);
    switch (stmt.type) {
      case "assign":
        this.env.vars.set(stmt.name, this.eval(stmt.value));
        return;
      case "expr":
        this.eval(stmt.expr);
        return;
      case "return":
        throw new ReturnSignal(stmt.value ? this.eval(stmt.value) : { t: "none" });
      case "def":
        this.env.vars.set(stmt.name, {
          t: "fn",
          name: stmt.name,
          params: stmt.params,
          body: stmt.body,
          env: this.env,
        });
        return;
      case "for":
        this.execFor(stmt);
        return;
      case "if":
        for (const arm of stmt.arms) {
          if (truthy(this.eval(arm.test))) {
            this.execBlock(arm.body);
            return;
          }
        }
        if (stmt.elseBody) this.execBlock(stmt.elseBody);
        return;
      case "with": {
        const saved = this.capture();
        this.eval(stmt.context);
        this.execBlock(stmt.body);
        this.restore(saved);
        return;
      }
      case "repeat":
        this.execRepeat(stmt);
        return;
      case "ending":
        this.execEnding(stmt);
        return;
    }
  }

  private execFor(stmt: Extract<Stmt, { type: "for" }>) {
    const iter = this.eval(stmt.iter);
    if (iter.t === "range") {
      for (let n = iter.start; n < iter.end; n++) {
        this.tick(stmt.span);
        const local = new Env(this.env);
        const previous = this.env;
        this.env = local;
        local.vars.set(stmt.name, { t: "num", v: n });
        this.execBlock(stmt.body);
        this.env = previous;
      }
      return;
    }
    if (iter.t !== "list") throw new RuntimeError("for can walk a list or range()", stmt.iter.span);
    for (const item of iter.v) {
      this.tick(stmt.span);
      const local = new Env(this.env);
      const previous = this.env;
      this.env = local;
      local.vars.set(stmt.name, item);
      this.execBlock(stmt.body);
      this.env = previous;
    }
  }

  private execRepeat(stmt: Extract<Stmt, { type: "repeat" }>) {
    if (this.repeatStack.length) throw new RuntimeError("repeats can't nest", stmt.span);
    const times = this.needNum(this.eval(stmt.times), stmt.times.span);
    if (!Number.isInteger(times) || times < 2 || times > 8) {
      throw new RuntimeError("repeat() takes a whole number from 2 to 8", stmt.times.span);
    }
    this.repeatStack.push({
      id: this.nextRepeat++,
      times,
      sawEnding: false,
      leftIndex: new Map(),
      lastInRepeat: new Map(),
      lastInEnding: new Map(),
      endingFirst: new Set(),
    });
    this.execBlock(stmt.body);
    const open = this.repeatStack.pop()!;
    if (open.ending) this.closeEnding(open);
    if (!open.sawEnding) {
      for (const [key, loc] of open.lastInRepeat) {
        const bar = loc.seq.bars[loc.index]!;
        bar.markRight = true;
        bar.times = open.times;
        bar.jumpTo = open.leftIndex.get(key)!.index;
        bar.repeatId = open.id;
      }
    }
  }

  private execEnding(stmt: Extract<Stmt, { type: "ending" }>) {
    const open = this.repeatStack[this.repeatStack.length - 1];
    if (!open) throw new RuntimeError("ending() has to sit inside repeat()", stmt.span);
    if (open.ending) this.closeEnding(open);
    const number = this.needNum(this.eval(stmt.number), stmt.number.span);
    if (!Number.isInteger(number) || number < 1 || number > 8) {
      throw new RuntimeError("ending() takes 1, 2, 3, ...", stmt.number.span);
    }
    open.ending = number;
    open.sawEnding = true;
    open.lastInEnding.clear();
    this.execBlock(stmt.body);
    this.closeEnding(open);
  }

  private closeEnding(open: OpenRepeat) {
    for (const [key, loc] of open.lastInEnding) {
      const bar = loc.seq.bars[loc.index]!;
      bar.endingStop = true;
      if (open.ending === 1) {
        bar.markRight = true;
        bar.times = open.times;
        bar.jumpTo = open.leftIndex.get(key)!.index;
        bar.repeatId = open.id;
      }
    }
    open.lastInEnding.clear();
    open.ending = undefined;
  }

  private eval(expr: Expr): Val {
    this.tick(expr.span);
    switch (expr.type) {
      case "number":
        return { t: "num", v: expr.value };
      case "string":
        return { t: "str", v: expr.value };
      case "name":
        return this.lookup(expr.name, expr.span);
      case "list":
        return { t: "list", v: expr.items.map((item) => this.eval(item)) };
      case "unary": {
        const value = this.eval(expr.expr);
        if (expr.op === "not") return { t: "bool", v: !truthy(value) };
        return { t: "num", v: -this.needNum(value, expr.span) };
      }
      case "binary":
        return this.binary(expr);
      case "attr":
        return this.eval(expr.object);
      case "call":
        return this.call(expr);
    }
  }

  private binary(expr: Extract<Expr, { type: "binary" }>): Val {
    if (expr.op === "and") {
      const left = this.eval(expr.left);
      return truthy(left) ? this.eval(expr.right) : left;
    }
    if (expr.op === "or") {
      const left = this.eval(expr.left);
      return truthy(left) ? left : this.eval(expr.right);
    }
    const left = this.eval(expr.left);
    const right = this.eval(expr.right);
    if (expr.op === "+") {
      if (left.t === "str" || right.t === "str") return { t: "str", v: asText(left) + asText(right) };
      return { t: "num", v: this.needNum(left, expr.left.span) + this.needNum(right, expr.right.span) };
    }
    if (expr.op === "-") return { t: "num", v: this.needNum(left, expr.span) - this.needNum(right, expr.span) };
    if (expr.op === "*") {
      if (left.t === "str" && right.t === "num") return { t: "str", v: repeatText(left.v, right.v, expr.span) };
      if (right.t === "str" && left.t === "num") return { t: "str", v: repeatText(right.v, left.v, expr.span) };
      return { t: "num", v: this.needNum(left, expr.span) * this.needNum(right, expr.span) };
    }
    if (expr.op === "/") return { t: "num", v: this.needNum(left, expr.span) / this.needNum(right, expr.span) };
    const cmp = compare(left, right);
    const table: Record<string, boolean> = {
      "==": cmp === 0,
      "!=": cmp !== 0,
      "<": cmp < 0,
      ">": cmp > 0,
      "<=": cmp <= 0,
      ">=": cmp >= 0,
    };
    if (!(expr.op in table)) throw new RuntimeError(`unknown operator ${expr.op}`, expr.span);
    return { t: "bool", v: table[expr.op]! };
  }

  private call(expr: Extract<Expr, { type: "call" }>): Val {
    const args = expr.args.map((arg) => ({ ...arg, val: this.eval(arg.value) }));
    if (expr.callee.type === "attr") {
      const obj = this.eval(expr.callee.object);
      this.bindReceiver(obj, expr.span);
      return this.builtin(expr.callee.name, args, expr.span);
    }
    if (expr.callee.type === "name") {
      const value = this.lookup(expr.callee.name, expr.callee.span);
      if (value.t === "fn") return this.callFn(value, args, expr.span);
      if (BUILTIN_NAMES.includes(expr.callee.name as (typeof BUILTIN_NAMES)[number])) {
        return this.builtin(expr.callee.name, args, expr.span);
      }
    }
    throw new RuntimeError("that can't be called", expr.span);
  }

  private callFn(fn: Extract<Val, { t: "fn" }>, args: { name?: string; val: Val; span: Span }[], span: Span): Val {
    if (this.depth > MAX_CALLS) throw new RuntimeError(`call limit exceeded`, span);
    if (args.some((arg) => arg.name)) throw new RuntimeError("functions take positional arguments", span);
    if (args.length !== fn.params.length) {
      throw new RuntimeError(`${fn.name}() takes ${fn.params.length} arguments`, span);
    }
    const local = new Env(fn.env);
    fn.params.forEach((name, index) => local.vars.set(name, args[index]!.val));
    const previous = this.env;
    this.env = local;
    this.depth += 1;
    try {
      this.execBlock(fn.body);
      return { t: "none" };
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      throw error;
    } finally {
      this.depth -= 1;
      this.env = previous;
    }
  }

  private builtin(name: string, args: { name?: string; val: Val; span: Span; value: Expr }[], span: Span): Val {
    const positional = args.filter((arg) => !arg.name);
    const named = new Map(args.filter((arg): arg is typeof arg & { name: string } => Boolean(arg.name)).map((arg) => [arg.name, arg]));
    const strAt = (index: number, key?: string) => {
      const arg = (key && named.get(key)) || positional[index];
      if (!arg) throw new RuntimeError(`${name}() is missing a value`, span);
      if (arg.val.t !== "str") throw new RuntimeError(`${name}() expects text`, arg.span);
      return arg.val.v;
    };
    const numAt = (index: number, key?: string, fallback?: number) => {
      const arg = (key && named.get(key)) || positional[index];
      if (!arg) {
        if (fallback !== undefined) return fallback;
        throw new RuntimeError(`${name}() is missing a number`, span);
      }
      return this.needNum(arg.val, arg.span);
    };
    switch (name) {
      case "title":
        this.title = strAt(0);
        return { t: "none" };
      case "composer":
        this.composer = strAt(0);
        return { t: "none" };
      case "tempo": {
        const bpm = numAt(0);
        if (bpm < 20 || bpm > 400) throw new RuntimeError("tempo should sit between 20 and 400", span);
        const started = this.parts.some((part) => part.seqs.some((seq) => seq.bars.length > 0));
        if (!started) this.openingTempo = bpm;
        this.tempo = bpm;
        this.tempoPending = true;
        return { t: "none" };
      }
      case "time": {
        const parsed = parseTime(strAt(0));
        if (!parsed) throw new RuntimeError("time looks like \"4/4\" or \"6/8\"", span);
        this.time = parsed;
        return { t: "none" };
      }
      case "key": {
        const parsed = parseKey(strAt(0));
        if (!parsed) throw new RuntimeError("unknown key. Try C, G, D, F, Bb, or Eb", span);
        this.key = parsed;
        return { t: "none" };
      }
      case "clef": {
        const clef = parseClef(strAt(0));
        if (!clef) throw new RuntimeError("clef is treble, bass, alto, or tenor", span);
        const part = this.ensurePart();
        part.clefs.set(this.staff, clef);
        return { t: "none" };
      }
      case "notes":
        this.writeNotes(positional[0]?.val ?? named.get("music")?.val, positional[0]?.span ?? span, exprContent(positional[0]));
        return { t: "none" };
      case "part":
        return this.makePart(strAt(0), numAt(1, "staves", 1), named.get("sound")?.val, named.get("gain")?.val, span);
      case "staff": {
        const part = this.ensurePart();
        const staff = numAt(0);
        if (!Number.isInteger(staff) || staff < 1 || staff > part.staffCount) {
          throw new RuntimeError(`${part.name} has ${part.staffCount} staff${part.staffCount === 1 ? "" : "s"}`, span);
        }
        this.staff = staff;
        this.voice = 1;
        return { t: "staff", index: this.partIndex, staff };
      }
      case "voice": {
        this.ensurePart();
        const voice = numAt(0);
        if (!Number.isInteger(voice) || voice < 1 || voice > 4) throw new RuntimeError("voice() takes 1 to 4", span);
        this.voice = voice;
        return { t: "voice", index: this.partIndex, staff: this.staff, voice };
      }
      case "pickup": {
        const parsed = parseTime(strAt(0));
        if (!parsed) throw new RuntimeError("pickup looks like \"1/4\"", span);
        this.pickup = r(parsed.beats * 4, parsed.beatType);
        return { t: "none" };
      }
      case "sound": {
        const part = this.ensurePart();
        part.sound = strAt(0);
        return { t: "none" };
      }
      case "gain": {
        const part = this.ensurePart();
        const gain = numAt(0);
        if (gain < 0 || gain > 1) throw new RuntimeError("gain() is from 0 to 1", span);
        part.gain = gain;
        return { t: "none" };
      }
      case "dynamic": {
        const word = strAt(0);
        if (!isDynamic(word)) throw new RuntimeError("unknown dynamic", span);
        this.pendingDynamic = word;
        if (this.wedgeOpen) this.closeWedge();
        return { t: "none" };
      }
      case "articulation": {
        const word = strAt(0);
        if (!isArticulation(word)) throw new RuntimeError("articulation is staccato, accent, or tenuto", span);
        this.pendingArts.push(word);
        return { t: "none" };
      }
      case "lyric":
        this.lyricPending = strAt(0);
        return { t: "none" };
      case "layout":
        this.applyLayout(named, span);
        return { t: "none" };
      case "break_system":
        this.pendingBreak = "system";
        return { t: "none" };
      case "break_page":
        this.pendingBreak = "page";
        return { t: "none" };
      case "crescendo":
        if (this.wedgeOpen) this.closeWedge();
        this.wedgeArm = "crescendo";
        return { t: "none" };
      case "diminuendo":
        if (this.wedgeOpen) this.closeWedge();
        this.wedgeArm = "diminuendo";
        return { t: "none" };
      case "wedge_stop":
        this.closeWedge();
        return { t: "none" };
      case "slur_start":
        this.slurStartPending = true;
        return { t: "none" };
      case "slur_end": {
        const last = this.lastNote();
        if (last) last.slurStop = true;
        return { t: "none" };
      }
      case "transpose": {
        try {
          return { t: "str", v: transposeMusic(strAt(0), strAt(1)) };
        } catch (error) {
          throw new RuntimeError(error instanceof Error ? error.message : "bad transpose", span);
        }
      }
      case "range": {
        const end = positional.length > 1 ? numAt(1) : numAt(0);
        const start = positional.length > 1 ? numAt(0) : 0;
        if (!Number.isInteger(start) || !Number.isInteger(end)) throw new RuntimeError("range() takes whole numbers", span);
        return { t: "range", start, end };
      }
      default:
        throw new RuntimeError(`unknown name ${name}`, span);
    }
  }

  private makePart(name: string, staves: number, sound: Val | undefined, gain: Val | undefined, span: Span): Val {
    if (!Number.isInteger(staves) || staves < 1 || staves > 4) throw new RuntimeError("staves is 1 to 4", span);
    const part: PartDraft = {
      name,
      sound: sound?.t === "str" ? sound.v : "piano",
      gain: gain?.t === "num" ? Math.min(1, Math.max(0, gain.v)) : 1,
      staffCount: staves,
      clefs: new Map(),
      seqs: [],
    };
    if (staves > 1) part.clefs.set(2, "bass");
    this.parts.push(part);
    this.partIndex = this.parts.length - 1;
    this.staff = 1;
    this.voice = 1;
    return { t: "part", index: this.partIndex };
  }

  private writeNotes(value: Val | undefined, span: Span, contentStart?: number) {
    if (!value || value.t !== "str") throw new RuntimeError("notes() expects text, like notes(\"c4 e4 g4 c5 |\")", span);
    const parsed = parseMini(value.v, contentStart ?? span.start);
    if (contentStart === undefined) {
      for (const bar of parsed.bars) {
        for (const event of bar) event.span = span;
      }
    }
    if (parsed.issues.length) {
      this.issues.push(...parsed.issues);
      return;
    }
    this.paint(parsed.bars);
    const part = this.ensurePart();
    const seq = this.sequence(part);
    for (const events of parsed.bars) {
      this.noteCount += events.reduce((sum, event) => sum + (event.kind === "note" ? event.pitches.length : 0), 0);
      if (this.noteCount > MAX_NOTES) throw new RuntimeError(`note limit of ${MAX_NOTES} exceeded`, span);
      const index = seq.bars.length;
      const issue = checkBar(events, expectedQuarters(this.time, index, this.pickup), index + 1, this.time, span);
      if (issue) this.issues.push(issue);
      const draft: BarDraft = { events };
      if (!seq.shownTime || seq.shownTime.beats !== this.time.beats || seq.shownTime.beatType !== this.time.beatType) {
        draft.time = this.time;
        seq.shownTime = this.time;
      }
      if (!seq.shownKey || seq.shownKey.fifths !== this.key.fifths) {
        draft.key = this.key;
        seq.shownKey = this.key;
      }
      const clef = part.clefs.get(this.staff) ?? (this.staff === 1 ? "treble" : "bass");
      if (seq.shownClef !== clef) {
        draft.clef = clef;
        seq.shownClef = clef;
      }
      if (this.tempoPending) {
        draft.tempo = this.tempo;
        this.tempoPending = false;
      }
      if (this.pendingBreak === "system") draft.systemBreak = true;
      if (this.pendingBreak === "page") draft.pageBreak = true;
      this.pendingBreak = undefined;
      this.stampRepeat(part, seq, draft);
      seq.bars.push(draft);
    }
  }

  private paint(bars: ScoreEvent[][]) {
    let armed = this.wedgeArm;
    for (const bar of bars) {
      for (const event of bar) {
        if (event.kind !== "note") continue;
        if (this.pendingDynamic && !event.dynamic) {
          event.dynamic = this.pendingDynamic;
          this.pendingDynamic = undefined;
        }
        if (this.pendingArts.length) {
          for (const art of this.pendingArts) {
            if (!event.articulations.includes(art)) event.articulations.push(art);
          }
          this.pendingArts = [];
        }
        if (this.lyricPending && !event.lyric) {
          event.lyric = this.lyricPending;
          this.lyricPending = undefined;
        }
        if (this.slurStartPending) {
          event.slurStart = true;
          this.slurStartPending = false;
        }
        if (armed) {
          event.wedgeStart = armed;
          armed = undefined;
          this.wedgeArm = undefined;
          this.wedgeOpen = true;
        }
      }
    }
  }

  private stampRepeat(_part: PartDraft, seq: Seq, draft: BarDraft) {
    const open = this.repeatStack[this.repeatStack.length - 1];
    if (!open) return;
    const key = `${this.partIndex}:${seq.staff}:${seq.voice}`;
    const index = seq.bars.length;
    if (!open.leftIndex.has(key)) {
      open.leftIndex.set(key, { seq, index });
      draft.markLeft = true;
    }
    draft.repeatId = open.id;
    open.lastInRepeat.set(key, { seq, index });
    if (open.ending) {
      draft.ending = open.ending;
      const mark = `${key}:${open.ending}`;
      if (!open.endingFirst.has(mark)) {
        draft.endingStart = true;
        open.endingFirst.add(mark);
      }
      open.lastInEnding.set(key, { seq, index });
    }
  }

  private closeWedge() {
    const note = this.lastNote();
    if (note && this.wedgeOpen) note.wedgeStop = true;
    this.wedgeOpen = false;
    this.wedgeArm = undefined;
  }

  private lastNote() {
    const part = this.parts[this.partIndex];
    if (!part) return undefined;
    const seq = part.seqs.find((item) => item.staff === this.staff && item.voice === this.voice) ?? part.seqs[part.seqs.length - 1];
    if (!seq) return undefined;
    for (let b = seq.bars.length - 1; b >= 0; b--) {
      const events = seq.bars[b]!.events;
      for (let e = events.length - 1; e >= 0; e--) {
        const event = events[e]!;
        if (event.kind === "note") return event;
      }
    }
    return undefined;
  }

  private finish(): Score | null {
    if (this.wedgeOpen) this.closeWedge();
    if (this.issues.length) return null;
    const parts: Part[] = [];
    this.parts.forEach((draft, index) => {
      const count = draft.seqs.reduce((max, seq) => Math.max(max, seq.bars.length), 0);
      if (count === 0) return;
      for (const seq of draft.seqs) {
        if (seq.bars.length !== count) {
          this.issues.push({
            message: `${draft.name} staff ${seq.staff} voice ${seq.voice} has ${seq.bars.length} bars, and another voice has ${count}`,
            start: 0,
            end: 0,
          });
        }
      }
      for (let staff = 1; staff <= draft.staffCount; staff++) {
        if (!draft.seqs.some((seq) => seq.staff === staff)) {
          this.issues.push({
            message: `${draft.name} staff ${staff} has no music`,
            start: 0,
            end: 0,
          });
        }
      }
      const measures: Measure[] = [];
      for (let i = 0; i < count; i++) {
        const staves = [];
        let repeat: RepeatMark | undefined;
        let time: TimeSignature | undefined;
        let key: KeySignature | undefined;
        let tempo: number | undefined;
        let systemBreak = false;
        let pageBreak = false;
        const clefs: { staff: number; clef: Clef }[] = [];
        for (let staff = 1; staff <= draft.staffCount; staff++) {
          const voices = draft.seqs
            .filter((seq) => seq.staff === staff && seq.bars[i])
            .map((seq) => ({ voice: seq.voice, events: seq.bars[i]!.events }));
          if (voices.length) staves.push({ staff, voices });
          for (const seq of draft.seqs.filter((item) => item.staff === staff)) {
            const bar = seq.bars[i];
            if (!bar) continue;
            if (bar.time) time = bar.time;
            if (bar.key) key = bar.key;
            if (bar.tempo) tempo = bar.tempo;
            if (bar.clef) clefs.push({ staff, clef: bar.clef });
            if (bar.systemBreak) systemBreak = true;
            if (bar.pageBreak) pageBreak = true;
            if (bar.markLeft || bar.markRight || bar.ending) {
              repeat = {
                ...repeat,
                left: repeat?.left || bar.markLeft,
                right: repeat?.right || bar.markRight,
                times: bar.times ?? repeat?.times,
                jumpTo: bar.jumpTo ?? repeat?.jumpTo,
                repeatId: bar.repeatId ?? repeat?.repeatId,
                ending: bar.ending ?? repeat?.ending,
                endingStart: repeat?.endingStart || bar.endingStart,
                endingStop: repeat?.endingStop || bar.endingStop,
              };
            }
          }
        }
        measures.push({
          number: i + 1,
          time,
          key,
          clefs: clefs.length ? clefs : undefined,
          tempo,
          staves,
          repeat,
          systemBreak,
          pageBreak,
        });
      }
      if (measures[0] && measures[0].tempo === undefined) measures[0].tempo = this.openingTempo;
      parts.push({
        id: `P${index + 1}`,
        name: draft.name,
        sound: draft.sound,
        gain: draft.gain,
        staffCount: draft.staffCount,
        measures,
      });
    });
    if (this.issues.length) return null;
    return {
      title: this.title,
      composer: this.composer,
      tempo: this.openingTempo,
      time: this.time,
      key: this.key,
      pickup: this.pickup,
      layout: this.layout,
      parts,
    };
  }

  private applyLayout(named: Map<string, { val: Val; span: Span }>, span: Span) {
    const num = (key: string) => {
      const arg = named.get(key);
      if (!arg) return undefined;
      return this.needNum(arg.val, arg.span);
    };
    const page = named.get("page");
    if (page) {
      if (page.val.t !== "str" || (page.val.v !== "A4" && page.val.v !== "Letter")) {
        throw new RuntimeError("page is \"A4\" or \"Letter\"", page.span);
      }
      this.layout.page = page.val.v;
    }
    const margin = num("margin");
    if (margin !== undefined) this.layout.margin = margin;
    const musicTop = num("music_top");
    if (musicTop !== undefined) this.layout.musicTop = musicTop;
    const musicBottom = num("music_bottom");
    if (musicBottom !== undefined) this.layout.musicBottom = musicBottom;
    const staffDistance = num("staff_distance");
    if (staffDistance !== undefined) this.layout.staffDistance = staffDistance;
    const grand = num("grand_staff_distance");
    if (grand !== undefined) this.layout.grandStaffDistance = grand;
    const minSystem = num("min_system_distance");
    if (minSystem !== undefined) this.layout.minSystemDistance = minSystem;
    const maxSystem = num("max_system_distance");
    if (maxSystem !== undefined) this.layout.maxSystemDistance = maxSystem;
    void span;
  }

  private sequence(part: PartDraft): Seq {
    let seq = part.seqs.find((item) => item.staff === this.staff && item.voice === this.voice);
    if (!seq) {
      seq = { staff: this.staff, voice: this.voice, bars: [] };
      part.seqs.push(seq);
    }
    return seq;
  }

  private ensurePart(): PartDraft {
    if (this.partIndex < 0) this.makePart("Piano", 1, { t: "str", v: "piano" }, undefined, { start: 0, end: 0 });
    return this.parts[this.partIndex]!;
  }

  private bindReceiver(value: Val, span: Span) {
    if (value.t === "part") {
      this.partIndex = value.index;
      this.staff = 1;
      this.voice = 1;
      return;
    }
    if (value.t === "staff") {
      this.partIndex = value.index;
      this.staff = value.staff;
      this.voice = 1;
      return;
    }
    if (value.t === "voice") {
      this.partIndex = value.index;
      this.staff = value.staff;
      this.voice = value.voice;
      return;
    }
    throw new RuntimeError("that has no music to write", span);
  }

  private lookup(name: string, span: Span): Val {
    if (name === "True") return { t: "bool", v: true };
    if (name === "False") return { t: "bool", v: false };
    if (name === "None") return { t: "none" };
    const found = this.env.get(name);
    if (!found) throw new RuntimeError(`unknown name ${name}`, span);
    if (found.t === "str" && (BUILTIN_NAMES as readonly string[]).includes(found.v) && found.v === name && !this.env.parent) {
      return found;
    }
    return found;
  }

  private capture() {
    return { partIndex: this.partIndex, staff: this.staff, voice: this.voice };
  }

  private restore(saved: { partIndex: number; staff: number; voice: number }) {
    this.partIndex = saved.partIndex;
    this.staff = saved.staff;
    this.voice = saved.voice;
  }

  private needNum(value: Val, span: Span): number {
    if (value.t !== "num") throw new RuntimeError("expected a number", span);
    return value.v;
  }

  private tick(span: Span) {
    this.steps += 1;
    if (this.steps > MAX_STEPS) throw new RuntimeError(`step limit of ${MAX_STEPS} exceeded`, span);
  }
}

function exprContent(arg: { val: Val; span: Span; value?: Expr } | undefined): number | undefined {
  const value = (arg as { value?: Expr } | undefined)?.value;
  if (value?.type === "string") return value.contentStart;
  return undefined;
}

function truthy(value: Val): boolean {
  if (value.t === "bool") return value.v;
  if (value.t === "none") return false;
  if (value.t === "num") return value.v !== 0;
  if (value.t === "str") return value.v.length > 0;
  if (value.t === "list") return value.v.length > 0;
  return true;
}

function asText(value: Val): string {
  if (value.t === "str") return value.v;
  if (value.t === "num") return String(value.v);
  if (value.t === "bool") return value.v ? "True" : "False";
  if (value.t === "none") return "None";
  return "";
}

function repeatText(text: string, times: number, span: Span): string {
  const count = Math.floor(times);
  if (count < 0) throw new RuntimeError("can't repeat text a negative number of times", span);
  if (text.length * count > 100_000) throw new RuntimeError("that text is too long", span);
  return text.repeat(count);
}

function compare(left: Val, right: Val): number {
  if (left.t === "num" && right.t === "num") return left.v - right.v;
  if (left.t === "str" && right.t === "str") return left.v < right.v ? -1 : left.v > right.v ? 1 : 0;
  return asText(left) < asText(right) ? -1 : asText(left) > asText(right) ? 1 : 0;
}

export function positionOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}
