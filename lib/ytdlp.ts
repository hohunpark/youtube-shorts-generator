import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegBinary, fileExists, runCommand } from "@/lib/command";
import { parseVtt, type TimedCue } from "@/lib/timed-text";
import { fetchTimedCaptions } from "@/lib/youtube-captions";
import { saveSectionViaBackup } from "@/lib/youtube-media";

const YT_DLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PLAYER_CLIENTS = ["android_vr", "web_safari", "tv_embedded"];

export class SourceDownloadError extends Error {
  blocked: boolean;

  constructor(message: string, blocked = false) {
    super(message);
    this.blocked = blocked;
  }
}

export type SourceCaptions = {
  cues: TimedCue[];
  language: string;
};

export async function downloadCaptionCues(videoId: string): Promise<SourceCaptions> {
  const fromApi = await captionsFromTranscript(videoId);
  if (fromApi) return fromApi;

  const dir = sourceDir(videoId);
  await mkdir(dir, { recursive: true });
  const url = watchUrl(videoId);

  try {
    await runYtDlp(
      [
        "--no-playlist",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "ko.*,ko,en.*",
        "--convert-subs",
        "vtt",
        "--ffmpeg-location",
        path.dirname(ffmpegBinary()),
        "-o",
        path.join(dir, "source.%(ext)s"),
        url,
      ],
      20000,
    );
  } catch (error) {
    throw asDownloadError(error);
  }

  const vttPath = await findVtt(dir);
  if (!vttPath) {
    const fallback = await captionsFromTranscript(videoId);
    if (fallback) return fallback;
    throw new SourceDownloadError("이 영상에서 자막 파일을 찾지 못했습니다.");
  }

  const cues = parseVtt(await readFile(vttPath, "utf8"));
  if (cues.length < 2) {
    throw new SourceDownloadError("자막이 너무 짧아서 구간을 고르기 어렵습니다.");
  }

  return { cues, language: languageFromName(vttPath) };
}

export async function downloadClip(input: {
  videoId: string;
  startSec: number;
  endSec: number;
}): Promise<string> {
  const dir = sourceDir(input.videoId);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    ["clip.mp4", "clip.webm", "clip.mkv"].map((name) => rm(path.join(dir, name), { force: true })),
  );
  const section = `*${ytClock(input.startSec)}-${ytClock(input.endSec)}`;

  try {
    await runYtDlp(
      [
        "--no-playlist",
        "--force-overwrites",
        "--force-keyframes-at-cuts",
        "--download-sections",
        section,
        "-f",
        "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b",
        "--merge-output-format",
        "mp4",
        "--ffmpeg-location",
        path.dirname(ffmpegBinary()),
        "-o",
        path.join(dir, "clip.%(ext)s"),
        watchUrl(input.videoId),
      ],
      20000,
    );
  } catch (error) {
    const saved = await saveSectionViaBackup({
      videoId: input.videoId,
      startSec: input.startSec,
      endSec: input.endSec,
      output: path.join(dir, "clip.mp4"),
    });
    if (!saved) throw asDownloadError(error);
  }

  const clipPath = await existingClipPath(input.videoId);
  if (!clipPath) {
    throw new SourceDownloadError("잘라 둔 원본 영상을 찾지 못했습니다.");
  }

  await writeFile(
    path.join(dir, "clip.json"),
    JSON.stringify({ startSec: input.startSec, endSec: input.endSec }),
  );
  return clipPath;
}

export async function downloadMontage(input: {
  videoId: string;
  parts: { startSec: number; endSec: number }[];
}): Promise<string> {
  if (input.parts.length < 2) {
    const only = input.parts[0];
    if (!only) throw new SourceDownloadError("이어 붙일 하이라이트 구간이 없습니다.");
    return downloadClip({ videoId: input.videoId, startSec: only.startSec, endSec: only.endSec });
  }

  const dir = sourceDir(input.videoId);
  await mkdir(dir, { recursive: true });
  const signature = input.parts
    .map((part) => `${part.startSec.toFixed(2)}-${part.endSec.toFixed(2)}`)
    .join("|");
  const cached = await readClipMeta(dir);
  const ready = await existingClipPath(input.videoId);
  if (cached?.signature === signature && ready) return ready;

  const partPaths: string[] = [];
  for (let index = 0; index < input.parts.length; index += 1) {
    const part = input.parts[index];
    const target = path.join(dir, `part-${index}.mp4`);
    await rm(target, { force: true });
    const section = `*${ytClock(part.startSec)}-${ytClock(part.endSec)}`;
    try {
      await runYtDlp(
        [
          "--no-playlist",
          "--force-overwrites",
          "--force-keyframes-at-cuts",
          "--download-sections",
          section,
          "-f",
          "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b",
          "--merge-output-format",
          "mp4",
          "--ffmpeg-location",
          path.dirname(ffmpegBinary()),
          "-o",
          target,
          watchUrl(input.videoId),
        ],
        20000,
      );
    } catch (error) {
      if (!part) throw asDownloadError(error);
      const saved = await saveSectionViaBackup({
        videoId: input.videoId,
        startSec: part.startSec,
        endSec: part.endSec,
        output: target,
      });
      if (!saved) throw asDownloadError(error);
    }
    if (!(await fileExists(target))) {
      throw new SourceDownloadError(`${index + 1}번 하이라이트 조각을 받지 못했습니다.`);
    }
    partPaths.push(target);
  }

  const clipPath = path.join(dir, "clip.mp4");
  await rm(clipPath, { force: true });
  const specs = partPaths.map((_, index) => {
    return `[${index}:v:0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}];[${index}:a:0]aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`;
  });
  const concat = partPaths.map((_, index) => `[v${index}][a${index}]`).join("");
  try {
    await runCommand(
      ffmpegBinary(),
      [
        "-y",
        ...partPaths.flatMap((partPath) => ["-i", partPath]),
        "-filter_complex",
        `${specs.join(";")};${concat}concat=n=${partPaths.length}:v=1:a=1[v][a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        clipPath,
      ],
      180000,
    );
  } catch (error) {
    throw asDownloadError(error);
  }

  const duration = input.parts.reduce((sum, part) => sum + (part.endSec - part.startSec), 0);
  await writeFile(
    path.join(dir, "clip.json"),
    JSON.stringify({ signature, startSec: 0, endSec: duration }),
  );
  return clipPath;
}

export async function ensureSectionClip(input: {
  videoId: string;
  startSec: number;
  endSec: number;
}): Promise<string> {
  const dir = sourceDir(input.videoId);
  try {
    const meta = await readClipMeta(dir);
    const clip = await existingClipPath(input.videoId);
    if (
      clip &&
      meta &&
      typeof meta.startSec === "number" &&
      typeof meta.endSec === "number" &&
      Math.abs(meta.startSec - input.startSec) < 0.6 &&
      Math.abs(meta.endSec - input.endSec) < 0.6 &&
      (!meta.signature || input.startSec < 0.6)
    ) {
      return clip;
    }
  } catch {
    // The saved section belongs to another range, so download this one.
  }

  return downloadClip(input);
}

async function readClipMeta(dir: string): Promise<{
  startSec?: number;
  endSec?: number;
  signature?: string;
} | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "clip.json"), "utf8")) as {
      startSec?: number;
      endSec?: number;
      signature?: string;
    };
  } catch {
    return null;
  }
}

export async function existingClipPath(videoId: string): Promise<string | null> {
  const dir = sourceDir(videoId);
  for (const name of ["clip.mp4", "clip.webm", "clip.mkv"]) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function captionsFromTranscript(videoId: string): Promise<SourceCaptions | null> {
  try {
    return await fetchTimedCaptions(videoId);
  } catch {
    return null;
  }
}

async function ytDlpGuardArgs(client: string): Promise<string[]> {
  const args = [
    "--user-agent",
    YT_USER_AGENT,
    "--referer",
    "https://www.youtube.com/",
    "--add-header",
    "Accept-Language:ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "--extractor-args",
    `youtube:player_client=${client}`,
    "--socket-timeout",
    "10",
    "--retries",
    "1",
    "--extractor-retries",
    "1",
    "--fragment-retries",
    "1",
  ];
  const proxy = readEnv("YOUTUBE_PROXY");
  if (proxy) args.push("--proxy", proxy);
  const cookies = await ensureCookieFile();
  if (cookies) args.push("--cookies", cookies);
  return args;
}

async function ensureCookieFile(): Promise<string | null> {
  const raw = readEnv("YOUTUBE_COOKIES") || readEnv("YTDLP_COOKIES");
  if (!raw) return null;
  if (!raw.includes("\n") && !raw.includes("=") && (await fileExists(raw))) return raw;
  if (!raw.includes("\n") && !raw.includes("\t") && (await fileExists(raw))) return raw;

  const file = path.join(process.cwd(), ".data", "bin", "youtube-cookies.txt");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, normalizeCookies(raw), "utf8");
  return file;
}

function normalizeCookies(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    const fromJson = cookiesFromJson(text);
    if (fromJson) return fromJson;
  }
  if (text.includes("# Netscape") || text.includes("\t")) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }

  const lines = ["# Netscape HTTP Cookie File"];
  for (const pair of text.replace(/^cookie:\s*/i, "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    lines.push(`.youtube.com\tTRUE\t/\tTRUE\t0\t${name}\t${value}`);
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : `${text}\n`;
}

function cookiesFromJson(text: string): string | null {
  try {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data) ? data : [data];
    const lines = ["# Netscape HTTP Cookie File"];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = cookieField(row, ["name", "Name"]);
      const value = cookieField(row, ["value", "Value"]);
      if (!name || value == null) continue;
      const domain = cookieField(row, ["domain", "Domain"]) || ".youtube.com";
      const cookiePath = cookieField(row, ["path", "Path"]) || "/";
      const secure = row.secure === true || row.Secure === true;
      const expiry = Math.floor(Number(row.expirationDate ?? row.expiry ?? 0)) || 0;
      lines.push(
        `${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${cookiePath}\t${secure ? "TRUE" : "FALSE"}\t${expiry}\t${name}\t${value}`,
      );
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch {
    return null;
  }
}

function cookieField(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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

function isBotBlock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /confirm you.?re not a bot|not a bot/i.test(message);
}

async function runYtDlp(args: string[], timeoutMs: number): Promise<void> {
  const bin = await ensureYtDlp();
  await runCommand(
    bin,
    [...(await ytDlpGuardArgs(PLAYER_CLIENTS.join(","))), ...args],
    timeoutMs,
  );
}

async function ensureYtDlp(): Promise<string> {
  const onPath = await commandOnPath("yt-dlp");
  if (onPath) return onPath;

  const local = path.join(process.cwd(), ".data", "bin", "yt-dlp.exe");
  if (await fileExists(local)) return local;

  await mkdir(path.dirname(local), { recursive: true });
  const response = await fetch(YT_DLP_URL);
  if (!response.ok || !response.body) {
    throw new SourceDownloadError("yt-dlp를 받지 못했습니다. 네트워크를 확인해 주세요.");
  }

  await writeFile(local, Buffer.from(await response.arrayBuffer()));
  return local;
}

function sourceDir(videoId: string): string {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new SourceDownloadError("영상 ID 형식이 아닙니다.");
  }
  return path.join(process.cwd(), ".data", "sources", videoId);
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function ytClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remain = safe % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${remain.toFixed(2).padStart(5, "0")}`;
}

async function findVtt(dir: string): Promise<string | null> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".vtt"));
  const preferred =
    names.find((name) => /\.ko[-.]/i.test(name) || name.includes(".ko.")) ??
    names.find((name) => name.includes(".ko")) ??
    names.find((name) => name.includes(".en")) ??
    names[0];
  return preferred ? path.join(dir, preferred) : null;
}

function languageFromName(filePath: string): string {
  const name = path.basename(filePath);
  if (name.includes(".ko")) return "ko";
  if (name.includes(".en")) return "en";
  return "auto";
}

function commandOnPath(name: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    const child = spawn(locator, [name], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null);
    });
  });
}

function asDownloadError(error: unknown): SourceDownloadError {
  const message = error instanceof Error ? error.message : "";
  if (isBotBlock(error)) {
    return new SourceDownloadError(
      "유튜브가 서버 요청을 자동 접속으로 막고 있습니다. 잠시 뒤 다시 시도해 주세요.",
      true,
    );
  }
  if (/private video|sign in|login/i.test(message)) {
    return new SourceDownloadError("비공개 영상이거나 로그인해야 볼 수 있습니다.");
  }
  if (/unavailable|not available/i.test(message)) {
    return new SourceDownloadError("영상을 찾을 수 없거나 공개 상태가 아닙니다.");
  }
  if (/caption|subtitles/i.test(message) && /not available/i.test(message)) {
    return new SourceDownloadError("이 영상에는 가져올 수 있는 자막이 없습니다.");
  }
  if (error instanceof SourceDownloadError) return error;
  return new SourceDownloadError("유튜브 영상이나 자막을 받지 못했습니다.");
}
