import { parseVtt, type TimedCue } from "@/lib/timed-text";
import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResponse,
} from "youtube-transcript";

export class CaptionFetchError extends Error {}

export type YouTubeCaptions = {
  text: string;
  language: string;
  segmentCount: number;
};

export async function fetchTimedCaptions(videoId: string): Promise<{
  cues: TimedCue[];
  language: string;
}> {
  const rows = await loadTranscript(videoId);
  const cues = rows.flatMap((row) => {
    const text = cleanPiece(row.text);
    if (!text || isNoise(text)) return [];
    const startSec = row.offset / 1000;
    return [
      {
        startSec,
        endSec: startSec + Math.max(0.2, row.duration / 1000),
        text,
      },
    ];
  });

  if (cues.length < 2) {
    throw new CaptionFetchError("가져온 자막이 너무 짧아서 구간을 고르기 어렵습니다.");
  }

  return {
    cues,
    language: rows.find((row) => row.lang)?.lang ?? "auto",
  };
}

export async function fetchYouTubeCaptions(videoId: string): Promise<YouTubeCaptions> {
  const rows = await loadTranscript(videoId);
  const text = groupCaptionLines(rows);
  if (text.trim().length < 20) {
    throw new CaptionFetchError("가져온 자막이 너무 짧아서 대본으로 만들기 어렵습니다.");
  }

  return {
    text,
    language: rows.find((row) => row.lang)?.lang ?? "auto",
    segmentCount: rows.length,
  };
}

const INVIDIOUS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type InvidiousCaption = {
  label?: string;
  language_code?: string;
  languageCode?: string;
  url?: string;
};

async function loadTranscript(videoId: string): Promise<TranscriptResponse[]> {
  let lastError: unknown;
  try {
    return await withTimeout(YoutubeTranscript.fetchTranscript(videoId, { lang: "ko" }), 12000);
  } catch (error) {
    lastError = error;
    if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
      try {
        return await withTimeout(YoutubeTranscript.fetchTranscript(videoId), 12000);
      } catch (next) {
        lastError = next;
      }
    }
  }

  const backup = await fetchInvidiousTranscript(videoId);
  if (backup && backup.length >= 2) return backup;
  throw new CaptionFetchError(captionErrorMessage(lastError));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("자막 API 응답 시간이 초과되었습니다.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function invidiousHosts(): string[] {
  const fromEnv = process.env.INVIDIOUS_INSTANCES?.split(",")
    .map((host) => host.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (fromEnv?.length) return fromEnv;
  return [
    "https://inv.nadeko.net",
    "https://yt.artemislena.eu",
    "https://invidious.privacyredirect.com",
  ];
}

async function fetchInvidiousTranscript(videoId: string): Promise<TranscriptResponse[] | null> {
  for (const host of invidiousHosts()) {
    try {
      const listResponse = await fetch(`${host}/api/v1/captions/${videoId}`, {
        headers: { Accept: "application/json", "User-Agent": INVIDIOUS_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!listResponse.ok) continue;
      const list = (await listResponse.json()) as InvidiousCaption[];
      if (!Array.isArray(list)) continue;
      const track = pickCaption(list);
      if (!track?.url) continue;

      const captionUrl = track.url.startsWith("http")
        ? track.url
        : `${host}${track.url.startsWith("/") ? "" : "/"}${track.url}`;
      const bodyResponse = await fetch(captionUrl, {
        headers: { "User-Agent": INVIDIOUS_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!bodyResponse.ok) continue;

      const lang = captionLanguage(track);
      const rows = transcriptFromCaptionBody(await bodyResponse.text(), lang);
      if (rows.length >= 2) return rows;
    } catch {
      continue;
    }
  }
  return null;
}

function pickCaption(list: InvidiousCaption[]): InvidiousCaption | null {
  const code = (item: InvidiousCaption) => captionLanguage(item);
  return (
    list.find((item) => code(item) === "ko" && item.url) ??
    list.find((item) => code(item) === "en" && item.url) ??
    list.find((item) => item.url) ??
    null
  );
}

function captionLanguage(item: InvidiousCaption): string {
  return (item.languageCode || item.language_code || "auto").toLowerCase().split(/[-_]/)[0] || "auto";
}

function transcriptFromCaptionBody(raw: string, lang: string): TranscriptResponse[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
    return parseVtt(trimmed).map((cue) => ({
      text: cue.text,
      offset: Math.round(cue.startSec * 1000),
      duration: Math.max(200, Math.round((cue.endSec - cue.startSec) * 1000)),
      lang,
    }));
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return transcriptFromJson(trimmed, lang);
  return transcriptFromXml(trimmed, lang);
}

function transcriptFromJson(raw: string, lang: string): TranscriptResponse[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const events = Array.isArray(data)
    ? data
    : recordEvents(data, "events") ?? recordEvents(data, "captions") ?? [];
  const rows: TranscriptResponse[] = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const item = event as Record<string, unknown>;
    const text = captionText(item);
    if (!text) continue;
    const offset = millisecondField(item, ["tStartMs", "startMs", "offset"]) ?? secondField(item, ["start"]);
    if (offset == null) continue;
    const duration =
      millisecondField(item, ["dDurationMs", "durMs"]) ?? secondField(item, ["dur", "duration"]) ?? 200;
    rows.push({ text, offset, duration: duration > 0 ? duration : 200, lang });
  }

  return rows;
}

function recordEvents(data: unknown, key: string): unknown[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function captionText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.utf8 === "string") return item.utf8;
  if (!Array.isArray(item.segs)) return "";
  return item.segs
    .map((seg) => {
      if (!seg || typeof seg !== "object") return "";
      const utf8 = (seg as { utf8?: unknown }).utf8;
      return typeof utf8 === "string" ? utf8 : "";
    })
    .join("");
}

function millisecondField(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  }
  return null;
}

function secondField(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 1000);
  }
  return null;
}

function transcriptFromXml(raw: string, lang: string): TranscriptResponse[] {
  const rows: TranscriptResponse[] = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const match of raw.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    const start = Number(attrs.match(/\bstart="([\d.]+)"/)?.[1]);
    const dur = Number(attrs.match(/\bdur="([\d.]+)"/)?.[1]);
    const text = decodeXml(match[2] ?? "");
    if (!text || !Number.isFinite(start)) continue;
    rows.push({
      text,
      offset: Math.round(start * 1000),
      duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : 200,
      lang,
    });
  }
  return rows;
}

function decodeXml(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value: string) => safeCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => safeCodePoint(Number.parseInt(value, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  return String.fromCodePoint(value);
}

function groupCaptionLines(rows: TranscriptResponse[]): string {
  const lines: string[] = [];
  let buffer = "";
  let lastEnd = 0;

  for (const row of rows) {
    const piece = cleanPiece(row.text);
    if (!piece || isNoise(piece)) continue;

    const gap = row.offset - lastEnd;
    const shouldBreak =
      buffer.length > 0 && (gap > 1200 || /[.!?…]$/.test(buffer) || buffer.length >= 80);

    if (shouldBreak) {
      lines.push(buffer);
      buffer = piece;
    } else {
      buffer = buffer ? `${buffer} ${piece}` : piece;
    }

    lastEnd = row.offset + row.duration;
    if (lines.join("\n").length + buffer.length > 40000) break;
  }

  if (buffer) lines.push(buffer);
  return lines.join("\n");
}

function cleanPiece(text: string): string {
  return text
    .replace(/\n/g, " ")
    .replace(/\[\?[\s\S]*?\?\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoise(text: string): boolean {
  return /^[\[(［].+[\]）］]$/.test(text);
}

function captionErrorMessage(error: unknown): string {
  if (error instanceof YoutubeTranscriptTooManyRequestError) {
    return "유튜브가 요청을 잠시 막고 있습니다. 조금 뒤 다시 시도해 주세요.";
  }
  if (error instanceof YoutubeTranscriptVideoUnavailableError) {
    return "영상을 찾을 수 없거나 공개 상태가 아닙니다.";
  }
  if (
    error instanceof YoutubeTranscriptDisabledError ||
    error instanceof YoutubeTranscriptNotAvailableError
  ) {
    return "이 영상에는 가져올 수 있는 자막이 없습니다.";
  }
  if (error instanceof CaptionFetchError) return error.message;
  return "자막을 가져오지 못했습니다.";
}
