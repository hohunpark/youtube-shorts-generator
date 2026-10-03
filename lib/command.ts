import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));

export function ffmpegBinary(): string {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  const resolved = require("ffmpeg-static") as string | null;
  if (!resolved) throw new Error("ffmpeg 바이너리를 찾지 못했습니다.");
  return resolved;
}

export function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("작업 시간이 초과되었습니다."));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim() || `${path.basename(command)} 종료 코드 ${code}`));
    });
  });
}

export async function probeVideo(filePath: string): Promise<{
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
}> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegBinary(), ["-hide_banner", "-i", filePath], { windowsHide: true });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve(output));
  });

  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const size = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!duration || !size) {
    throw new Error("영상 길이와 해상도를 읽지 못했습니다.");
  }

  return {
    width: Number(size[1]),
    height: Number(size[2]),
    durationSec: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    hasAudio: /Audio:/.test(stderr),
  };
}

export function ffmpegPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(":", "\\:");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
