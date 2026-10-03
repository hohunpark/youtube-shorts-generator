import { EditPlanError, normalizeEditOptions } from "@/lib/edit-plan";
import { GeminiDraftError, planShortsEdit } from "@/lib/gemini";
import { cuesFromPlainText, formatClock, mergeCues } from "@/lib/timed-text";
import type { ClipOption, ConvertResult, DurationSec, EditStyle, PaceBeat, SceneGuide, SourceKind } from "@/lib/types";
import { createRenderJob } from "@/lib/render-preview";
import type { HookTitle, RenderJob, RenderRequest } from "@/lib/render-types";
import type { ShortsStep } from "@/lib/shorts-progress";
import { downloadCaptionCues, downloadClip, downloadMontage, SourceDownloadError } from "@/lib/ytdlp";

export class ConvertError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return isVideoId(id) ? id : null;
    }

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const watchId = url.searchParams.get("v");
      if (watchId && isVideoId(watchId)) return watchId;

      const parts = url.pathname.split("/").filter(Boolean);
      const head = parts[0];
      const id = parts[1];
      if (
        (head === "shorts" || head === "embed" || head === "live") &&
        id &&
        isVideoId(id)
      ) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function createYouTubeShort(
  input: { value: string; durationSec: DurationSec; editStyle?: EditStyle; apiKey?: string },
  onProgress: (step: Exclude<ShortsStep, 4>) => void,
): Promise<{ result: ConvertResult; job: RenderJob }> {
  const result = await convertFromYouTubeUrl(
    input.value.trim(),
    input.durationSec,
    input.editStyle ?? "continuous",
    input.apiKey,
    onProgress,
  );
  if (
    !result.videoId ||
    !result.title ||
    !result.hook ||
    !result.loopLine ||
    result.clipStartSec == null ||
    result.clipEndSec == null
  ) {
    throw new ConvertError("편집에 필요한 구간 정보가 없습니다.");
  }

  const joined = result.editStyle === "highlight" && result.options.length >= 2;
  const job = await createRenderJob(joined ? montageRequest(result) : singleRequest(result));
  return { result, job };
}

export async function convertInput(input: {
  source: SourceKind;
  value: string;
  durationSec: DurationSec;
  editStyle?: EditStyle;
  apiKey?: string;
}): Promise<ConvertResult> {
  if (input.source === "url") {
    return convertFromYouTubeUrl(
      input.value.trim(),
      input.durationSec,
      input.editStyle ?? "continuous",
      input.apiKey,
    );
  }

  return planFromCues({
    cues: mergeCues(cuesFromPlainText(input.value)),
    durationSec: input.durationSec,
    editStyle: input.editStyle ?? "continuous",
    apiKey: input.apiKey,
    videoId: null,
    language: null,
    segmentCount: null,
  });
}

async function convertFromYouTubeUrl(
  value: string,
  durationSec: DurationSec,
  editStyle: EditStyle,
  apiKey?: string,
  onProgress?: (step: Exclude<ShortsStep, 4>) => void,
): Promise<ConvertResult> {
  const videoId = parseYouTubeVideoId(value);
  if (!videoId) {
    throw new ConvertError("유튜브 영상 URL 형식이 아닙니다.");
  }

  onProgress?.(1);
  let captions;
  try {
    captions = await downloadCaptionCues(videoId);
  } catch (error) {
    if (error instanceof SourceDownloadError) throw new ConvertError(error.message);
    throw error;
  }

  onProgress?.(2);
  const plan = await planFromCues({
    cues: mergeCues(captions.cues),
    durationSec,
    editStyle,
    apiKey,
    videoId,
    language: captions.language,
    segmentCount: captions.cues.length,
  });

  onProgress?.(3);

  try {
    if (editStyle === "highlight" && plan.options.length >= 2) {
      await downloadMontage({
        videoId,
        parts: plan.options.map((option) => ({ startSec: option.startSec, endSec: option.endSec })),
      });
    } else {
      await downloadClip({
        videoId,
        startSec: plan.clipStartSec ?? 0,
        endSec: plan.clipEndSec ?? durationSec,
      });
    }
  } catch (error) {
    if (error instanceof SourceDownloadError) throw new ConvertError(error.message);
    throw error;
  }

  return { ...plan, hasSource: true };
}

async function planFromCues(input: {
  cues: ReturnType<typeof mergeCues>;
  durationSec: DurationSec;
  editStyle: EditStyle;
  apiKey?: string;
  videoId: string | null;
  language: string | null;
  segmentCount: number | null;
}): Promise<ConvertResult> {
  if (input.cues.length < 2) {
    throw new ConvertError("변환할 자막이 너무 짧습니다. 문장을 조금 더 붙여 넣어 주세요.");
  }

  let raw;
  try {
    raw = await planShortsEdit({
      cues: input.cues,
      durationSec: input.durationSec,
      editStyle: input.editStyle,
      apiKey: input.apiKey,
    });
  } catch (error) {
    if (error instanceof GeminiDraftError) {
      throw new ConvertError(error.message, error.message.includes("GEMINI_API_KEY") ? 400 : 502);
    }
    throw error;
  }

  let edits;
  try {
    edits = normalizeEditOptions({
      rawOptions: raw.options,
      cues: input.cues,
      durationSec: input.durationSec,
      editStyle: input.editStyle,
    });
  } catch (error) {
    if (error instanceof EditPlanError) throw new ConvertError(error.message);
    throw error;
  }

  const edit = edits[0];
  if (!edit) {
    throw new ConvertError("쇼츠로 자를 구간을 고르지 못했습니다.");
  }

  const options = edits.map(toClipOption);
  const language = input.language ? languageLabel(input.language) : null;
  const clipLabel = `${formatClock(edit.startSec)}–${formatClock(edit.endSec)}`;
  const readSeconds = Math.max(8, Math.round(edit.endSec - edit.startSec));

  return {
    status: "ready",
    sourceLabel: input.videoId
      ? `영상 ${input.videoId} · ${language} 자막`
      : "붙여 넣은 자막",
    videoId: input.videoId,
    title: edit.title,
    hook: edit.hook,
    script: edit.spoken,
    durationSec: input.durationSec,
    readSeconds,
    scenes: scenesFromBeats(edit.beats, edit.startSec),
    clipStartSec: edit.startSec,
    clipEndSec: edit.endSec,
    loopLine: edit.loopLine,
    beats: edit.beats,
    options,
    editStyle: input.editStyle,
    hasSource: false,
    notice: edit.shortened
      ? "영상 자막이 목표보다 짧아서, 있는 구간 전체를 쇼츠로 잡았습니다."
      : input.videoId
        ? null
        : "붙여 넣은 텍스트에는 원본 영상이 없어 9:16 편집은 하지 않습니다. 유튜브 주소로 다시 실행해 주세요.",
    pipeline: [
      {
        id: "ingest",
        label: "입력 확인",
        detail: input.videoId
          ? `영상 ID ${input.videoId}를 읽었습니다.`
          : "붙여 넣은 텍스트를 시간 자막처럼 나눴습니다.",
        state: "done",
      },
      {
        id: "captions",
        label: "영상 수집",
        detail: input.videoId
          ? `${language} 자막 ${input.segmentCount}줄을 받았고, ${clipLabel} 구간 영상을 저장합니다.`
          : "원본 MP4는 유튜브 주소가 있을 때만 받습니다.",
        state: "done",
      },
      {
        id: "rank",
        label: "구간 추출",
        detail: `${raw.model}이 상위 ${options.length}개 구간과 3초 훅을 골랐습니다.`,
        state: "done",
      },
      {
        id: "compose",
        label: "연출 구성",
        detail: `2~3초 단위 ${edit.beats.length}개 비트에 키워드, 줌, 효과음 시점을 넣었습니다.`,
        state: "done",
      },
    ],
  };
}

function singleRequest(result: ConvertResult): RenderRequest {
  const option = result.options[0];
  return {
    videoId: result.videoId ?? "",
    title: result.title ?? "",
    hook: option?.hook ?? result.hook ?? "",
    hookKeyword: option?.hookKeyword ?? "",
    loopLine: result.loopLine ?? "",
    durationSec: result.durationSec,
    clipStartSec: result.clipStartSec ?? 0,
    clipEndSec: result.clipEndSec ?? result.durationSec,
    beats: result.beats,
  };
}

function montageRequest(result: ConvertResult): RenderRequest {
  let cursor = 0;
  const beats: PaceBeat[] = [];
  const titles: HookTitle[] = [];

  for (const option of result.options) {
    const span = Math.max(0.5, option.endSec - option.startSec);
    titles.push({
      startSec: round2(cursor),
      endSec: round2(cursor + span),
      hook: option.hook,
      keyword: option.hookKeyword,
    });
    for (const beat of option.beats) {
      const start = Math.min(beat.startSec, span);
      const end = Math.min(beat.endSec, span);
      if (end <= start) continue;
      beats.push({
        ...beat,
        startSec: round2(cursor + start),
        endSec: round2(cursor + end),
        sfxSec: beat.sfxSec == null ? null : round2(cursor + Math.min(beat.sfxSec, span)),
      });
    }
    cursor += span;
  }

  return {
    videoId: result.videoId ?? "",
    title: result.title ?? "",
    hook: result.hook ?? "",
    hookKeyword: result.options[0]?.hookKeyword ?? "",
    loopLine: result.loopLine ?? "",
    durationSec: result.durationSec,
    clipStartSec: 0,
    clipEndSec: round2(cursor),
    beats,
    titles,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toClipOption(edit: {
  title: string;
  hook: string;
  hookKeyword: string;
  loopLine: string;
  startSec: number;
  endSec: number;
  beats: PaceBeat[];
  spoken: string;
}): ClipOption {
  return {
    title: edit.title,
    hook: edit.hook,
    hookKeyword: edit.hookKeyword,
    loopLine: edit.loopLine,
    startSec: edit.startSec,
    endSec: edit.endSec,
    beats: edit.beats,
    spoken: edit.spoken,
    scenes: scenesFromBeats(edit.beats, edit.startSec),
    readSeconds: Math.max(8, Math.round(edit.endSec - edit.startSec)),
  };
}

function scenesFromBeats(beats: PaceBeat[], clipStartSec: number): SceneGuide[] {
  return beats.map((beat, index) => {
    const zoom = beat.zoom === "in" ? "줌인" : "줌아웃";
    const sfx = beat.sfxSec == null ? "효과음 없음" : `효과음 ${formatClock(clipStartSec + beat.sfxSec)}`;
    const label = index === 0 ? "훅" : index === beats.length - 1 ? "마무리" : "페이싱";
    return {
      label,
      timeRange: `${formatClock(clipStartSec + beat.startSec)}–${formatClock(clipStartSec + beat.endSec)}`,
      line: beat.caption,
      direction: `${zoom} · 강조 ${beat.keyword} · ${sfx}`,
      keywords: [beat.keyword],
    };
  });
}

function languageLabel(code: string): string {
  if (code.startsWith("ko")) return "한국어";
  if (code.startsWith("en")) return "영어";
  if (code === "auto") return "기본";
  return code;
}

function isVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}
