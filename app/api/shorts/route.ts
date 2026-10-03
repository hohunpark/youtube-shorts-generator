import { ConvertError, createYouTubeShort } from "@/lib/pipeline";
import { RenderError } from "@/lib/render-preview";
import { shortsMessage, type ShortsStep } from "@/lib/shorts-progress";
import { isDurationSec, isEditStyle } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON 형식이 아닙니다." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "요청 본문이 비어 있습니다." }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  if (typeof record.value !== "string" || !isDurationSec(record.durationSec)) {
    return Response.json({ error: "영상 주소와 목표 길이를 확인해 주세요." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const outcome = await createYouTubeShort(
          {
            value: record.value as string,
            durationSec: record.durationSec as 30 | 45 | 60,
            editStyle: isEditStyle(record.editStyle) ? record.editStyle : "continuous",
            apiKey: readApiKey(record.apiKey),
          },
          (step) => {
            send({ type: "progress", step, message: shortsMessage(step) });
          },
        );
        const done: ShortsStep = 4;
        send({
          type: "done",
          step: done,
          message: shortsMessage(done),
          result: outcome.result,
          job: outcome.job,
        });
      } catch (error) {
        const message =
          error instanceof ConvertError || error instanceof RenderError
            ? error.message
            : "쇼츠를 만들지 못했습니다.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

function readApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().slice(0, 256);
  return key || undefined;
}
