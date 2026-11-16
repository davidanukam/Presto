import { freqOf, type SourceSpan, type Timeline, type TimelineEvent } from "@presto/score";
import { Soundfont, SplendidGrandPiano } from "smplr";

export type MixerStrip = { volume: number; mute: boolean; solo: boolean };
export type Mixer = Record<string, MixerStrip>;

export type PlayListener = (seconds: number, spans: SourceSpan[]) => void;

const BUNDLED_MIDIS = [48, 52, 55, 60, 64, 67, 72, 76, 79, 84];

const FONT_NAMES: Record<string, string> = {
  piano: "acoustic_grand_piano",
  violin: "violin",
  viola: "viola",
  cello: "cello",
  flute: "flute",
  oboe: "oboe",
  clarinet: "clarinet",
  bassoon: "bassoon",
  trumpet: "trumpet",
  horn: "french_horn",
  trombone: "trombone",
  tuba: "tuba",
  guitar: "acoustic_guitar_nylon",
  organ: "church_organ",
};

type Voice = { start: (note: number | string, when: number, duration: number, velocity: number) => void; stop: () => void };

export class Player {
  private ctx: AudioContext | null = null;
  private stops: Array<() => void> = [];
  private timer = 0;
  private anchor = 0;
  private offset = 0;
  private playing = false;
  private paused = false;
  private timeline: Timeline | null = null;
  private rate = 1;
  private mixer: Mixer = {};
  private listener: PlayListener = () => {};
  private gains = new Map<string, GainNode>();
  private bundled = new Map<number, AudioBuffer>();
  private bundledLoading: Promise<void> | null = null;
  private pianos = new Map<string, SplendidGrandPiano>();
  private fonts = new Map<string, Soundfont>();
  private readyPianos = new Set<string>();
  private readyFonts = new Set<string>();

  get isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  async play(
    timeline: Timeline,
    mixer: Mixer,
    rate: number,
    listener: PlayListener,
    fromSeconds = 0,
  ): Promise<void> {
    this.halt();
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    this.timeline = timeline;
    this.mixer = mixer;
    this.rate = rate;
    this.listener = listener;
    this.offset = Math.max(0, Math.min(fromSeconds, timeline.durationSeconds));
    await this.prepare(timeline);
    this.anchor = ctx.currentTime + 0.06 - this.offset / this.rate;
    this.playing = true;
    this.paused = false;
    this.schedule(this.offset);
    this.follow();
  }

  pause(): void {
    if (!this.playing || this.paused || !this.ctx || !this.timeline) return;
    this.offset = (this.ctx.currentTime - this.anchor) * this.rate;
    this.silence();
    this.paused = true;
    cancelAnimationFrame(this.timer);
  }

  resume(): void {
    if (!this.playing || !this.paused || !this.ctx || !this.timeline) return;
    this.anchor = this.ctx.currentTime - this.offset / this.rate;
    this.paused = false;
    this.schedule(this.offset);
    this.follow();
  }

  /** Current playback or pause position in seconds. */
  get position(): number {
    if (!this.ctx || !this.timeline) return this.offset;
    if (this.playing && !this.paused) {
      return Math.max(0, (this.ctx.currentTime - this.anchor) * this.rate);
    }
    return this.offset;
  }

  get isPaused(): boolean {
    return this.playing && this.paused;
  }

  /** Move the cue point without starting playback. */
  cue(seconds: number): void {
    if (!this.timeline) {
      this.offset = Math.max(0, seconds);
      return;
    }
    this.offset = Math.max(0, Math.min(seconds, this.timeline.durationSeconds));
    if (this.playing && !this.paused && this.ctx) {
      this.silence();
      this.anchor = this.ctx.currentTime - this.offset / this.rate;
      this.schedule(this.offset);
    }
    const spans = this.spansAt(this.offset);
    this.listener(this.offset, spans);
  }

  stop(): void {
    this.halt();
    this.listener(0, []);
  }

  private halt(): void {
    this.silence();
    this.playing = false;
    this.paused = false;
    this.offset = 0;
    cancelAnimationFrame(this.timer);
  }

  private spansAt(seconds: number): SourceSpan[] {
    if (!this.timeline) return [];
    return this.timeline.events
      .filter((event) => event.span && seconds >= event.startSeconds && seconds < event.startSeconds + event.durationSeconds)
      .map((event) => event.span!);
  }

  setMixer(mixer: Mixer): void {
    this.mixer = mixer;
    if (!this.timeline) return;
    for (const event of this.timeline.events) this.applyGain(event.partId, event.gain);
  }

  private schedule(fromSeconds: number) {
    const ctx = this.context();
    const timeline = this.timeline;
    if (!timeline) return;
    const now = ctx.currentTime;
    for (const event of timeline.events) {
      const start = this.anchor + event.startSeconds / this.rate;
      const duration = Math.max(0.05, event.durationSeconds / this.rate);
      if (start + duration < now) continue;
      if (event.startSeconds < fromSeconds - 0.001 && start < now) continue;
      const when = Math.max(start, now);
      this.speak(event, when, duration);
    }
  }

  private speak(event: TimelineEvent, when: number, duration: number) {
    const ctx = this.context();
    const destination = this.partGain(event.partId, event.gain);
    const audible = destination.gain.value;
    if (audible <= 0.001) return;
    const piano = this.pianos.get(event.partId);
    if (event.sound === "piano" && piano && this.readyPianos.has(event.partId)) {
      const stop = piano.start({ note: event.midi, time: when, duration, velocity: event.velocity, stopId: `${event.partId}-${event.midi}-${when}` });
      this.stops.push(() => stop());
      return;
    }
    const font = this.fonts.get(event.partId);
    if (font && this.readyFonts.has(event.partId)) {
      const stop = font.start({ note: event.midi, time: when, duration, velocity: event.velocity });
      this.stops.push(() => stop());
      return;
    }
    if (event.sound === "piano" && this.bundled.size) {
      this.stops.push(this.playSample(event, when, duration, destination));
      return;
    }
    this.stops.push(this.playOscillator(event, when, duration, destination, ctx));
  }

  private playSample(event: TimelineEvent, when: number, duration: number, destination: GainNode): () => void {
    const ctx = this.context();
    const root = nearest(event.midi, [...this.bundled.keys()]);
    const buffer = this.bundled.get(root);
    if (!buffer) return this.playOscillator(event, when, duration, destination, ctx);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** ((event.midi - root) / 12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(event.velocity / 127, when);
    source.connect(gain);
    gain.connect(destination);
    source.start(when);
    source.stop(when + duration);
    return () => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    };
  }

  private playOscillator(event: TimelineEvent, when: number, duration: number, destination: GainNode, ctx: AudioContext): () => void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveFor(event.sound);
    osc.frequency.setValueAtTime(freqOf(event.midi), when);
    const peak = (event.velocity / 127) * 0.18;
    gain.gain.setValueAtTime(peak, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + duration + 0.02);
    return () => {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    };
  }

  private async prepare(timeline: Timeline) {
    const ctx = this.context();
    this.bundledLoading ??= this.loadBundled(ctx);
    const jobs: Promise<void>[] = [this.bundledLoading];
    const seen = new Set<string>();
    for (const event of timeline.events) {
      if (seen.has(event.partId)) continue;
      seen.add(event.partId);
      this.partGain(event.partId, event.gain);
      if (event.sound === "piano" && !this.pianos.has(event.partId)) {
        const piano = new SplendidGrandPiano(ctx);
        this.pianos.set(event.partId, piano);
        jobs.push(
          piano.loaded().then(
            () => {
              this.readyPianos.add(event.partId);
            },
            () => undefined,
          ),
        );
      } else if (event.sound !== "piano" && !this.fonts.has(event.partId)) {
        const font = new Soundfont(ctx, { instrument: FONT_NAMES[event.sound] ?? event.sound, kit: "FluidR3_GM" });
        this.fonts.set(event.partId, font);
        jobs.push(
          font.loaded().then(
            () => {
              this.readyFonts.add(event.partId);
            },
            () => undefined,
          ),
        );
      }
    }
    await Promise.race([Promise.all(jobs), wait(350)]);
  }

  private async loadBundled(ctx: AudioContext) {
    await Promise.all(
      BUNDLED_MIDIS.map(async (midi) => {
        try {
          const response = await fetch(`/samples/piano/${midi}.wav`);
          if (!response.ok) return;
          const audio = await ctx.decodeAudioData(await response.arrayBuffer());
          this.bundled.set(midi, audio);
        } catch {
          /* offline or missing sample */
        }
      }),
    );
  }

  private partGain(partId: string, written: number): GainNode {
    const ctx = this.context();
    let gain = this.gains.get(partId);
    if (!gain) {
      gain = ctx.createGain();
      gain.connect(ctx.destination);
      this.gains.set(partId, gain);
    }
    this.applyGain(partId, written);
    return gain;
  }

  private applyGain(partId: string, written: number) {
    const gain = this.gains.get(partId);
    if (!gain || !this.ctx) return;
    const strip = this.mixer[partId] ?? { volume: 0.8, mute: false, solo: false };
    const anySolo = Object.values(this.mixer).some((item) => item.solo);
    const level = strip.mute || (anySolo && !strip.solo) ? 0 : strip.volume * written;
    gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.01);
  }

  private follow() {
    const tick = () => {
      if (!this.playing || this.paused || !this.ctx || !this.timeline) return;
      const seconds = (this.ctx.currentTime - this.anchor) * this.rate;
      if (seconds >= this.timeline.durationSeconds) {
        this.stop();
        return;
      }
      this.listener(Math.max(0, seconds), this.spansAt(seconds));
      this.timer = requestAnimationFrame(tick);
    };
    this.timer = requestAnimationFrame(tick);
  }

  private silence() {
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const piano of this.pianos.values()) piano.stop();
    for (const font of this.fonts.values()) font.stop();
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }
}

function nearest(midi: number, roots: number[]): number {
  return roots.reduce((best, root) => (Math.abs(root - midi) < Math.abs(best - midi) ? root : best), roots[0] ?? midi);
}

function waveFor(sound: string): OscillatorType {
  if (sound === "flute" || sound === "organ") return "sine";
  if (sound === "violin" || sound === "viola" || sound === "cello") return "sawtooth";
  if (sound === "trumpet" || sound === "trombone" || sound === "tuba" || sound === "horn") return "square";
  return "triangle";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { Voice };
