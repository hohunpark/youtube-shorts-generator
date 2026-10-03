import type { TimedCue } from "@/lib/timed-text";
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

async function loadTranscript(videoId: string): Promise<TranscriptResponse[]> {
  try {
    try {
      return await YoutubeTranscript.fetchTranscript(videoId, { lang: "ko" });
    } catch (error) {
      if (!(error instanceof YoutubeTranscriptNotAvailableLanguageError)) throw error;
      return await YoutubeTranscript.fetchTranscript(videoId);
    }
  } catch (error) {
    throw new CaptionFetchError(captionErrorMessage(error));
  }
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
