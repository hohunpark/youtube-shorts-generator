import { stat } from "node:fs/promises";
import { ffmpegBinary, runCommand } from "@/lib/command";

const MEDIA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type StreamRow = {
  url?: string;
  container?: string;
  qualityLabel?: string;
  quality?: string;
  mimeType?: string;
  videoOnly?: boolean;
  itag?: string;
};

export async function saveSectionViaBackup(input: {
  videoId: string;
  startSec: number;
  endSec: number;
  output: string;
}): Promise<boolean> {
  const urls = await mediaUrls(input.videoId);
  for (const url of urls.slice(0, 1)) {
    const saved = await cutRemote(url, input.startSec, input.endSec, input.output, 20000);
    if (saved) return true;
  }
  return false;
}

async function mediaUrls(videoId: string): Promise<string[]> {
  const [rapid, cobalt, invidious, piped] = await Promise.all([
    rapidApiUrl(videoId),
    cobaltUrls(videoId),
    invidiousUrls(videoId),
    pipedUrls(videoId),
  ]);
  const preferred = [rapid[0], cobalt[0], invidious.find((url) => url.includes("local=true")), piped[0]];
  return uniqueUrls([...preferred, ...cobalt, ...invidious, ...piped, ...rapid]);
}

function uniqueUrls(urls: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    if (!url?.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

async function cobaltUrls(videoId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const host of listEnv("COBALT_API_URLS", ["https://api.cobalt.tools"])) {
    try {
      const response = await fetch(host, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": MEDIA_USER_AGENT,
        },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          videoQuality: "720",
          downloadMode: "auto",
          alwaysProxy: true,
          youtubeVideoCodec: "h264",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { status?: string; url?: string };
      if ((payload.status === "tunnel" || payload.status === "redirect") && payload.url?.startsWith("http")) {
        urls.push(payload.url);
      }
    } catch {
      continue;
    }
  }
  return urls;
}

async function invidiousUrls(videoId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const host of listEnv("INVIDIOUS_INSTANCES", [
    "https://inv.nadeko.net",
    "https://yt.artemislena.eu",
    "https://invidious.privacyredirect.com",
  ])) {
    urls.push(`${host}/latest_version?id=${videoId}&itag=18&local=true`);
    try {
      const response = await fetch(`${host}/api/v1/videos/${videoId}?local=true`, {
        headers: { Accept: "application/json", "User-Agent": MEDIA_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { formatStreams?: StreamRow[] };
      const local = (payload.formatStreams ?? [])
        .map((row) => row.url)
        .filter((url): url is string => Boolean(url?.startsWith(host)));
      urls.push(...local);
    } catch {
      continue;
    }
  }
  return urls;
}

async function pipedUrls(videoId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const host of listEnv("PIPED_API_INSTANCES", [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
  ])) {
    try {
      const response = await fetch(`${host}/streams/${videoId}`, {
        headers: { Accept: "application/json", "User-Agent": MEDIA_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { videoStreams?: StreamRow[] };
      const local = (payload.videoStreams ?? [])
        .filter((row) => row.videoOnly !== true && row.url?.startsWith(host))
        .map((row) => row.url)
        .filter((url): url is string => Boolean(url));
      urls.push(...local);
    } catch {
      continue;
    }
  }
  return urls;
}

async function rapidApiUrl(videoId: string): Promise<string[]> {
  const key = readEnv("RAPIDAPI_KEY");
  const host = readEnv("RAPIDAPI_HOST");
  if (!key || !host) return [];

  const template = readEnv("RAPIDAPI_YOUTUBE_URL") || `https://${host}/dl?id={id}`;
  const endpoint = template.includes("{id}") ? template.replaceAll("{id}", videoId) : template;
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": host,
        "User-Agent": MEDIA_USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as unknown;
    const url = findHttpUrl(payload);
    return url ? [url] : [];
  } catch {
    return [];
  }
}

function findHttpUrl(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string" && value.startsWith("http")) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHttpUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "link", "downloadUrl", "videoUrl"]) {
    const found = findHttpUrl(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

async function cutRemote(
  url: string,
  startSec: number,
  endSec: number,
  output: string,
  timeoutMs: number,
): Promise<boolean> {
  const proxy = readEnv("YOUTUBE_PROXY");
  try {
    await runCommand(
      ffmpegBinary(),
      [
        "-y",
        ...(proxy ? ["-http_proxy", proxy] : []),
        "-ss",
        startSec.toFixed(2),
        "-to",
        endSec.toFixed(2),
        "-user_agent",
        MEDIA_USER_AGENT,
        "-headers",
        "Referer: https://www.youtube.com/\r\n",
        "-i",
        url,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output,
      ],
      timeoutMs,
    );
  } catch {
    return false;
  }

  try {
    const info = await stat(output);
    return info.size > 1000;
  } catch {
    return false;
  }
}

function listEnv(name: string, fallback: string[]): string[] {
  const fromEnv = readEnv(name)
    .split(",")
    .map((host) => host.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : fallback;
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
