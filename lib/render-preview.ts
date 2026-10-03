import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatClock } from "@/lib/timed-text";
import type { RenderJob, RenderRequest } from "@/lib/render-types";
import { renderVerticalShort, VerticalEditError } from "@/lib/vertical-edit";

export class RenderError extends Error {}

export async function createRenderJob(input: RenderRequest): Promise<RenderJob> {
  try {
    const rendered = await renderVerticalShort(input);
    return {
      id: rendered.id,
      status: "ready",
      durationSec: input.durationSec,
      videoUrl: `/api/preview/${rendered.id}`,
      cleanVideoUrl: `/api/preview/${rendered.id}?variant=clean`,
      mimeType: "video/mp4",
      notice: rendered.notice,
      clipLabel:
        input.titles && input.titles.length > 1
          ? "교차 편집"
          : `${formatClock(input.clipStartSec)}–${formatClock(input.clipEndSec)}`,
      beats: input.beats.map((beat) => ({
        timeRange: `${formatClock(input.clipStartSec + beat.startSec)}–${formatClock(input.clipStartSec + beat.endSec)}`,
        keyword: beat.keyword,
        zoom: beat.zoom,
        sfxLabel: beat.sfxSec == null ? "효과음 없음" : `효과음 ${beat.sfxSec.toFixed(1)}초`,
        caption: beat.caption,
      })),
    };
  } catch (error) {
    if (error instanceof VerticalEditError) throw new RenderError(error.message);
    throw new RenderError("세로 쇼츠를 만들지 못했습니다.");
  }
}

export async function readPreviewFile(
  id: string,
  variant: "full" | "clean" = "full",
): Promise<Buffer | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const filePath = path.join(
    process.cwd(),
    ".data",
    "renders",
    id,
    variant === "clean" ? "clean.mp4" : "preview.mp4",
  );
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
