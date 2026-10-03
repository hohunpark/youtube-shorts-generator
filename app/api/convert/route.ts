import { ConvertError, convertInput } from "@/lib/pipeline";
import { isDurationSec, isEditStyle, isSourceKind } from "@/lib/types";

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
  if (
    !isSourceKind(record.source) ||
    typeof record.value !== "string" ||
    !isDurationSec(record.durationSec)
  ) {
    return Response.json(
      { error: "입력 종류, 내용, 목표 길이를 확인해 주세요." },
      { status: 400 },
    );
  }

  try {
    const result = await convertInput({
      source: record.source,
      value: record.value,
      durationSec: record.durationSec,
      editStyle: isEditStyle(record.editStyle) ? record.editStyle : "continuous",
      apiKey: typeof record.apiKey === "string" ? record.apiKey.trim().slice(0, 256) : undefined,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ConvertError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
