import type { DurationSec, EditStyle, PaceBeat, ZoomDirection } from "@/lib/types";
import type { GeminiOption } from "@/lib/gemini";
import { spokenInRange, type TimedCue } from "@/lib/timed-text";

export class EditPlanError extends Error {}

export type NormalizedEdit = {
  title: string;
  hook: string;
  hookKeyword: string;
  loopLine: string;
  startSec: number;
  endSec: number;
  beats: PaceBeat[];
  spoken: string;
  shortened: boolean;
};

export function normalizeEditOptions(input: {
  rawOptions: GeminiOption[];
  cues: TimedCue[];
  durationSec: DurationSec;
  editStyle?: EditStyle;
}): NormalizedEdit[] {
  if (input.editStyle === "highlight") {
    return normalizeHighlight(input.rawOptions, input.cues, input.durationSec);
  }

  const ranked = input.rawOptions
    .slice(0, 3)
    .map((raw) => normalizeEditPlan({ raw, cues: input.cues, durationSec: input.durationSec }));
  const distinct = dropOverlaps(ranked);
  return fillDistinctWindows(distinct, input.cues, input.durationSec).slice(0, 3);
}

export function normalizeEditPlan(input: {
  raw: GeminiOption;
  cues: TimedCue[];
  durationSec: DurationSec;
  targetSec?: number;
}): NormalizedEdit {
  const window = selectWindow(
    input.raw.startSec,
    input.raw.endSec,
    input.cues,
    input.targetSec ?? input.durationSec,
  );
  const beats = normalizeBeats(input.raw.beats, window.startSec, window.endSec, input.cues);
  const spoken = spokenInRange(input.cues, window.startSec, window.endSec);

  return {
    title: input.raw.title,
    hook: input.raw.hook,
    hookKeyword: input.raw.hookKeyword,
    loopLine: input.raw.loopLine || input.raw.hook,
    startSec: round2(window.startSec),
    endSec: round2(window.endSec),
    beats,
    spoken: spoken || beats.map((beat) => beat.caption).join(" "),
    shortened: window.shortened,
  };
}

function selectWindow(
  rawStart: number,
  rawEnd: number,
  cues: TimedCue[],
  durationSec: number,
): { startSec: number; endSec: number; shortened: boolean } {
  const availableStart = cues[0]?.startSec ?? 0;
  const availableEnd = cues.at(-1)?.endSec ?? rawEnd;
  const available = availableEnd - availableStart;
  if (available < 8) {
    throw new EditPlanError("자막이 너무 짧아서 쇼츠 구간을 만들 수 없습니다.");
  }

  const target = Math.min(durationSec, available);
  const shortened = available + 0.5 < durationSec;
  let start = rawStart;
  let end = rawEnd;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 8) {
    start = availableStart;
    end = availableStart + target;
  }

  const length = end - start;
  if (length < target * 0.75 || length > target * 1.25) {
    const center = clamp((start + end) / 2, availableStart + target / 2, availableEnd - target / 2);
    start = center - target / 2;
    end = start + target;
  }

  if (start < availableStart) {
    start = availableStart;
    end = start + target;
  }
  if (end > availableEnd) {
    end = availableEnd;
    start = Math.max(availableStart, end - target);
  }

  return { startSec: start, endSec: end, shortened };
}

function normalizeBeats(
  rawBeats: GeminiOption["beats"],
  startSec: number,
  endSec: number,
  cues: TimedCue[],
): PaceBeat[] {
  const duration = endSec - startSec;
  const relative = rawBeats
    .map((beat) => {
      const absolute = beat.startSec > duration && beat.startSec >= startSec - 1;
      const offset = absolute ? startSec : 0;
      return {
        startSec: beat.startSec - offset,
        endSec: beat.endSec - offset,
        keyword: beat.keyword,
        zoom: beat.zoom,
        sfxSec: beat.sfxSec == null ? null : beat.sfxSec - offset,
        caption: beat.caption,
      };
    })
    .filter((beat) => beat.endSec - beat.startSec >= 1)
    .sort((a, b) => a.startSec - b.startSec);

  const coverage = relative.reduce((sum, beat) => {
    const from = Math.max(0, beat.startSec);
    const to = Math.min(duration, beat.endSec);
    return sum + Math.max(0, to - from);
  }, 0);
  const sane =
    relative.length >= 3 &&
    coverage >= duration * 0.7 &&
    relative.every((beat) => {
      const span = beat.endSec - beat.startSec;
      return span >= 1.2 && span <= 4.5;
    });

  const base = sane ? relative : beatsFromCues(cues, startSec, endSec);
  return retouch(base, duration);
}

function beatsFromCues(cues: TimedCue[], startSec: number, endSec: number): PaceBeat[] {
  const duration = endSec - startSec;
  const beats: PaceBeat[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < duration - 0.4) {
    const beatEnd = Math.min(duration, cursor + 2.5);
    const text = spokenInRange(cues, startSec + cursor, startSec + beatEnd);
    const keyword = keywordFrom(text, index);
    beats.push({
      startSec: round2(cursor),
      endSec: round2(beatEnd),
      keyword,
      zoom: index % 2 === 0 ? "in" : "out",
      sfxSec: round2(cursor + 0.15),
      caption: keyword,
    });
    cursor = beatEnd;
    index += 1;
  }

  return beats;
}

function retouch(
  beats: Array<Omit<PaceBeat, "zoom"> & { zoom: ZoomDirection }>,
  duration: number,
): PaceBeat[] {
  const clipped = beats
    .map((beat) => ({
      ...beat,
      startSec: clamp(beat.startSec, 0, duration),
      endSec: clamp(beat.endSec, 0, duration),
    }))
    .filter((beat) => beat.endSec - beat.startSec >= 0.8);

  if (clipped.length === 0) {
    return [
      {
        startSec: 0,
        endSec: round2(duration),
        keyword: "포인트",
        zoom: "in",
        sfxSec: 0.2,
        caption: "포인트",
      },
    ];
  }

  clipped[0].startSec = 0;
  clipped[clipped.length - 1].endSec = duration;
  for (let index = 1; index < clipped.length; index += 1) {
    clipped[index].startSec = clipped[index - 1].endSec;
    if (clipped[index].endSec <= clipped[index].startSec) {
      clipped[index].endSec = Math.min(duration, clipped[index].startSec + 2);
    }
  }
  clipped[clipped.length - 1].endSec = duration;

  return clipped.map((beat, index) => {
    const keyword = beat.keyword.slice(0, 18) || "포인트";
    const caption = (beat.caption || keyword).slice(0, 24);
    const sfx = beat.sfxSec;
    const sfxSec =
      sfx != null && sfx >= beat.startSec && sfx <= beat.endSec
        ? round2(sfx)
        : round2(beat.startSec + 0.12);
    return {
      startSec: round2(beat.startSec),
      endSec: round2(beat.endSec),
      keyword,
      zoom: index % 2 === 0 ? "in" : "out",
      sfxSec,
      caption,
    };
  });
}

function normalizeHighlight(
  rawOptions: GeminiOption[],
  cues: TimedCue[],
  durationSec: number,
): NormalizedEdit[] {
  const availableStart = cues[0]?.startSec ?? 0;
  const availableEnd = cues.at(-1)?.endSec ?? 0;
  const span = availableEnd - availableStart;
  const piece = Math.min(15, Math.max(10, Math.round(durationSec / 3)));
  if (span < piece + 8) {
    return rawOptions.slice(0, 1).map((raw) =>
      normalizeEditPlan({ raw, cues, durationSec: durationSec as DurationSec }),
    );
  }

  return [0, 1, 2].map((index) => {
    const thirdStart = availableStart + (span * index) / 3;
    const thirdEnd = availableStart + (span * (index + 1)) / 3;
    const raw = rawOptions.find((option) => {
      const center = (option.startSec + option.endSec) / 2;
      return center >= thirdStart && center < thirdEnd;
    });
    const center = raw ? (raw.startSec + raw.endSec) / 2 : (thirdStart + thirdEnd) / 2;
    const startSec = clamp(center - piece / 2, thirdStart, Math.max(thirdStart, thirdEnd - piece));
    const endSec = Math.min(thirdEnd, startSec + piece);
    const thirdCues = cues.filter((cue) => cue.endSec > startSec && cue.startSec < endSec);
    if (!raw || thirdCues.length < 2) return windowFromCues(cues, startSec, endSec);
    return normalizeEditPlan({
      raw: { ...raw, startSec, endSec },
      cues: thirdCues,
      durationSec: durationSec as DurationSec,
      targetSec: Math.min(piece, Math.max(8, endSec - startSec)),
    });
  });
}

function dropOverlaps(options: NormalizedEdit[]): NormalizedEdit[] {
  const kept: NormalizedEdit[] = [];
  for (const option of [...options].sort((a, b) => a.startSec - b.startSec)) {
    const crowded = kept.some((item) => overlapSeconds(item, option.startSec, option.endSec) > 8);
    if (!crowded) kept.push(option);
  }
  return kept.length > 0 ? kept : options.slice(0, 1);
}

function fillDistinctWindows(
  options: NormalizedEdit[],
  cues: TimedCue[],
  durationSec: number,
): NormalizedEdit[] {
  const availableStart = cues[0]?.startSec ?? 0;
  const availableEnd = cues.at(-1)?.endSec ?? durationSec;
  const span = availableEnd - availableStart;
  const target = Math.min(durationSec, span);
  const filled = [...options];
  if (target < 8) return filled;

  const slots = [availableStart, availableStart + Math.max(0, (span - target) / 2), availableEnd - target];
  for (const slot of slots) {
    if (filled.length >= 3) break;
    const endSec = Math.min(availableEnd, slot + target);
    const startSec = Math.max(availableStart, endSec - target);
    if (endSec - startSec < 8) continue;
    if (filled.some((item) => overlapSeconds(item, startSec, endSec) > target * 0.35)) continue;
    filled.push(windowFromCues(cues, startSec, endSec));
  }

  return filled;
}

function windowFromCues(cues: TimedCue[], startSec: number, endSec: number): NormalizedEdit {
  const beats = beatsFromCues(cues, startSec, endSec);
  const spoken = spokenInRange(cues, startSec, endSec);
  const hook = Array.from(spoken || beats[0]?.caption || "이걸 놓쳐?").slice(0, 15).join("");
  const hookKeyword = hook.split(/\s+/).sort((a, b) => Array.from(b).length - Array.from(a).length)[0] ?? hook;
  return {
    title: hook,
    hook,
    hookKeyword: Array.from(hookKeyword).slice(0, 5).join(""),
    loopLine: `${hook} 다시 보자`.slice(0, 40),
    startSec: round2(startSec),
    endSec: round2(endSec),
    beats,
    spoken: spoken || beats.map((beat) => beat.caption).join(" "),
    shortened: false,
  };
}

function overlapSeconds(option: NormalizedEdit, startSec: number, endSec: number): number {
  return Math.max(0, Math.min(option.endSec, endSec) - Math.max(option.startSec, startSec));
}

function keywordFrom(text: string, index: number): string {
  const token = text
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .find((word) => word.length >= 2 && word.length <= 8);
  return token || `포인트 ${index + 1}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
