import { readPreviewFile } from "@/lib/render-preview";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") === "clean" ? "clean" : "full";
  const download = url.searchParams.get("download") === "1";
  const file = await readPreviewFile(id, variant);
  if (!file) {
    return Response.json({ error: "미리보기 영상이 없습니다." }, { status: 404 });
  }

  const filename = variant === "clean" ? "shorts-clean.mp4" : "shorts.mp4";
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Content-Length": String(file.byteLength),
    "Cache-Control": "public, max-age=86400",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="${filename}"`;

  return new Response(new Uint8Array(file), { headers });
}
