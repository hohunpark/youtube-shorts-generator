import { RenderError, createRenderJob } from "@/lib/render-preview";
import type { HookTitle, RenderRequest } from "@/lib/render-types";
import { isDurationSec, type PaceBeat, type ZoomDirection } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON 형식이 아닙니다." }, { status: 400 });
  }

  const parsed = readRenderRequest(body);
  if (!parsed) {
    return Response.json(
      { error: "원본 구간과 연출 비트가 있어야 세로 영상을 만들 수 있습니다." },
      { status: 400 },
    );
  }

  try {
    const job = await createRenderJob(parsed);
    return Response.json(job);
  } catch (error) {
    if (error instanceof RenderError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}

function readRenderRequest(body: unknown): RenderRequest | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.videoId !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/.test(record.videoId) ||
    typeof record.title !== "string" ||
    typeof record.hook !== "string" ||
    typeof record.loopLine !== "string" ||
    !isDurationSec(record.durationSec) ||
    typeof record.clipStartSec !== "number" ||
    typeof record.clipEndSec !== "number" ||
    record.clipEndSec <= record.clipStartSec ||
    !Array.isArray(record.beats)
  ) {
    return null;
  }

  const beats: PaceBeat[] = [];
  for (const beat of record.beats) {
    const parsed = readBeat(beat);
    if (!parsed) return null;
    beats.push(parsed);
  }
  if (beats.length === 0 || beats.length > 24) return null;

  return {
    videoId: record.videoId,
    title: record.title.slice(0, 80),
    hook: record.hook.slice(0, 40),
    hookKeyword: typeof record.hookKeyword === "string" ? record.hookKeyword.slice(0, 8) : "",
    loopLine: record.loopLine.slice(0, 160),
    durationSec: record.durationSec,
    clipStartSec: record.clipStartSec,
    clipEndSec: record.clipEndSec,
    beats,
    titles: readTitles(record.titles),
  };
}

function readTitles(value: unknown): HookTitle[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const titles: HookTitle[] = [];
  for (const item of value.slice(0, 3)) {
    if (!item || typeof item !== "object") return undefined;
    const title = item as Record<string, unknown>;
    if (
      typeof title.startSec !== "number" ||
      typeof title.endSec !== "number" ||
      title.endSec <= title.startSec ||
      typeof title.hook !== "string" ||
      typeof title.keyword !== "string"
    ) {
      return undefined;
    }
    titles.push({
      startSec: title.startSec,
      endSec: title.endSec,
      hook: title.hook.slice(0, 40),
      keyword: title.keyword.slice(0, 8),
    });
  }
  return titles;
}

function readBeat(value: unknown): PaceBeat | null {
  if (!value || typeof value !== "object") return null;
  const beat = value as Record<string, unknown>;
  if (
    typeof beat.startSec !== "number" ||
    typeof beat.endSec !== "number" ||
    beat.endSec <= beat.startSec ||
    typeof beat.keyword !== "string" ||
    typeof beat.caption !== "string" ||
    (beat.zoom !== "in" && beat.zoom !== "out")
  ) {
    return null;
  }

  const zoom: ZoomDirection = beat.zoom;
  const sfxSec = typeof beat.sfxSec === "number" && Number.isFinite(beat.sfxSec) ? beat.sfxSec : null;
  return {
    startSec: beat.startSec,
    endSec: beat.endSec,
    keyword: beat.keyword.slice(0, 24),
    zoom,
    sfxSec,
    caption: beat.caption.slice(0, 40),
  };
}
