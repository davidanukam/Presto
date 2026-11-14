import { useEffect, useRef } from "react";
import type { Layout, SourceSpan, Timeline } from "@presto/score";

type Props = {
  musicxml: string | null;
  layout: Layout;
  printing: boolean;
  seconds: number | null;
  timeline: Timeline | null;
  onPick: (span: SourceSpan) => void;
};

export function ScoreView({ musicxml, layout, printing, seconds, timeline, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OsmdLike | null>(null);
  const cursorAt = useRef(0);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    if (!host.current || !musicxml) {
      if (host.current) host.current.innerHTML = "";
      osmdRef.current = null;
      return;
    }
    (async () => {
      const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
      if (cancelled || !host.current) return;
      host.current.innerHTML = "";
      const osmd = new OpenSheetMusicDisplay(host.current, {
        backend: "svg",
        autoResize: true,
        drawTitle: true,
        drawComposer: true,
        drawPartNames: true,
        followCursor: false,
        pageFormat: printing ? (layout.page === "Letter" ? "Letter_P" : "A4_P") : "Endless",
      });
      const rules = osmd.EngravingRules;
      rules.StaffDistance = layout.staffDistance;
      rules.BetweenStaffDistance = layout.grandStaffDistance;
      rules.MinimumDistanceBetweenSystems = layout.minSystemDistance;
      rules.PageTopMargin = printing ? layout.musicTop : 2.2;
      rules.PageBottomMargin = printing ? layout.musicBottom : 2.2;
      rules.PageLeftMargin = printing ? layout.margin : 1.6;
      rules.PageRightMargin = printing ? layout.margin : 1.6;
      await osmd.load(musicxml);
      if (cancelled) return;
      osmd.render();
      osmd.cursor?.show();
      osmd.cursor?.reset();
      osmdRef.current = osmd as unknown as OsmdLike;
      cursorAt.current = 0;
    })().catch((error: unknown) => {
      if (!cancelled && host.current) {
        host.current.textContent = error instanceof Error ? error.message : "The sheet could not be drawn.";
      }
    });
    return () => {
      cancelled = true;
    };
  }, [musicxml, layout, printing]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      const span = nearestSpan(node, event.clientX, event.clientY);
      if (span) onPickRef.current(span);
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor || seconds == null || !timeline) return;
    const starts = uniqueStarts(timeline);
    let target = 0;
    while (target < starts.length && starts[target]! <= seconds + 0.03) target += 1;
    target = Math.max(0, target - 1);
    if (target < cursorAt.current) {
      osmd.cursor.reset();
      osmd.cursor.show();
      cursorAt.current = 0;
    }
    while (cursorAt.current < target && !osmd.cursor.iterator?.EndReached) {
      osmd.cursor.next();
      cursorAt.current += 1;
    }
    osmd.cursor.show();
  }, [seconds, timeline]);

  return <div className={printing ? "score-page printing" : "score-page"} ref={host} />;
}

type OsmdLike = {
  cursor?: {
    show: () => void;
    reset: () => void;
    next: () => void;
    iterator?: { EndReached?: boolean };
  };
};

function uniqueStarts(timeline: Timeline): number[] {
  const starts: number[] = [];
  for (const event of timeline.events) {
    const last = starts[starts.length - 1];
    if (last === undefined || Math.abs(last - event.startSeconds) > 0.0001) starts.push(event.startSeconds);
  }
  return starts;
}

function nearestSpan(host: HTMLElement, x: number, y: number): SourceSpan | null {
  const nodes = host.querySelectorAll<SVGGraphicsElement>("[id^='n']");
  let best: SourceSpan | null = null;
  let bestDistance = 36;
  nodes.forEach((node) => {
    const match = /^n(\d+)-(\d+)$/.exec(node.id);
    if (!match) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { start: Number(match[1]), end: Number(match[2]) };
    }
  });
  return best;
}
