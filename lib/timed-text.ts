export type TimedCue = {
  startSec: number;
  endSec: number;
  text: string;
};

export function parseVtt(raw: string): TimedCue[] {
  const blocks = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  const cues: TimedCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;

    const match = lines[timeIndex].match(
      /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/,
    );
    if (!match) continue;

    const startSec = vttStamp(match[1]);
    const endSec = vttStamp(match[2]);
    const text = cleanCue(lines.slice(timeIndex + 1).join(" "));
    if (!text || endSec <= startSec) continue;
    cues.push({ startSec, endSec, text });
  }

  return dedupeRolling(cues);
}

export function mergeCues(cues: TimedCue[], maxSpan = 4.5): TimedCue[] {
  const merged: TimedCue[] = [];

  for (const cue of cues) {
    const prev = merged.at(-1);
    const close = prev ? cue.startSec - prev.endSec < 0.6 : false;
    const fits = prev ? cue.endSec - prev.startSec <= maxSpan : false;
    const unfinished = prev ? !/[.!?…]$/.test(prev.text) : false;

    if (prev && close && fits && unfinished) {
      prev.endSec = cue.endSec;
      prev.text = `${prev.text} ${cue.text}`.replace(/\s+/g, " ").trim();
      continue;
    }

    merged.push({ ...cue });
  }

  return merged;
}

export function cuesForPrompt(cues: TimedCue[], limit = 28000): { text: string; truncated: boolean } {
  const lines = cues.map(
    (cue) => `[${cue.startSec.toFixed(2)}-${cue.endSec.toFixed(2)}] ${cue.text}`,
  );
  const full = lines.join("\n");
  if (full.length <= limit) return { text: full, truncated: false };

  const stride = Math.ceil(full.length / limit);
  return {
    text: lines.filter((_, index) => index % stride === 0).join("\n"),
    truncated: true,
  };
}

export function cuesFromPlainText(text: string): TimedCue[] {
  const parts = text
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

  let cursor = 0;
  return parts.map((part) => {
    const span = Math.min(6, Math.max(2, part.length / 4.6));
    const cue = { startSec: cursor, endSec: cursor + span, text: part };
    cursor += span;
    return cue;
  });
}

export function spokenInRange(cues: TimedCue[], startSec: number, endSec: number): string {
  return cues
    .filter((cue) => cue.endSec > startSec && cue.startSec < endSec)
    .map((cue) => cue.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatClock(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remain = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function vttStamp(value: string): number {
  const [clock, fraction] = value.replace(",", ".").split(".");
  const parts = clock.split(":").map(Number);
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return seconds + Number(fraction ?? 0) / 1000;
}

function cleanCue(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeRolling(cues: TimedCue[]): TimedCue[] {
  const kept: TimedCue[] = [];

  for (let index = 0; index < cues.length; index += 1) {
    const current = cues[index];
    const next = cues[index + 1];
    if (
      next &&
      next.text.startsWith(current.text) &&
      next.startSec - current.startSec < 2.5 &&
      current.text.length < next.text.length
    ) {
      continue;
    }

    const prev = kept.at(-1);
    if (prev && prev.text === current.text) {
      prev.endSec = Math.max(prev.endSec, current.endSec);
      continue;
    }

    kept.push({ ...current });
  }

  return kept;
}
