import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegBinary, ffmpegPath, fileExists, probeVideo, runCommand } from "@/lib/command";
import type { PaceBeat } from "@/lib/types";
import type { HookTitle } from "@/lib/render-types";
import { ensureSectionClip } from "@/lib/ytdlp";

const BOLD_FONT = "C:/Windows/Fonts/malgunbd.ttf";
const REGULAR_FONT = "C:/Windows/Fonts/malgun.ttf";
const CANVAS_W = 720;
const CANVAS_H = 1280;

export class VerticalEditError extends Error {}

export async function renderVerticalShort(input: {
  videoId: string;
  hook: string;
  hookKeyword?: string;
  loopLine: string;
  clipStartSec: number;
  clipEndSec: number;
  beats: PaceBeat[];
  titles?: HookTitle[];
}): Promise<{ id: string; notice: string }> {
  const sourcePath = await ensureSectionClip({
    videoId: input.videoId,
    startSec: input.clipStartSec,
    endSec: input.clipEndSec,
  });
  if (input.beats.length < 1) {
    throw new VerticalEditError("연출 비트 없이 세로 영상을 만들 수 없습니다.");
  }

  const probed = await probeVideo(sourcePath);
  const planned = Math.max(1, input.clipEndSec - input.clipStartSec);
  const beats = scaleBeats(input.beats, planned, probed.durationSec);
  const duration = round2(probed.durationSec);
  const layout = layoutFor(probed.width / probed.height);

  const id = randomUUID();
  const dir = path.join(process.cwd(), ".data", "renders", id);
  await mkdir(dir, { recursive: true });

  const font = (await fileExists(BOLD_FONT)) ? BOLD_FONT : REGULAR_FONT;
  if (!(await fileExists(font))) {
    throw new VerticalEditError("자막에 쓸 한글 폰트를 찾지 못했습니다.");
  }

  const titles = scaleTitles(
    input.titles?.length
      ? input.titles
      : [
          {
            startSec: 0,
            endSec: planned,
            hook: input.hook,
            keyword: input.hookKeyword ?? "",
          },
        ],
    planned,
    probed.durationSec,
  );
  const assPath = path.join(dir, "overlay.ass");
  await writeFile(assPath, `\uFEFF${buildAss(titles, beats, layout, duration)}`, "utf8");

  const popPath = path.join(dir, "pop.wav");
  await runCommand(
    ffmpegBinary(),
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=740:sample_rate=44100:duration=0.14",
      "-af",
      "afade=t=in:st=0:d=0.01,afade=t=out:st=0.04:d=0.1,volume=0.55",
      popPath,
    ],
    20000,
  );

  const outputPath = path.join(dir, "preview.mp4");
  const cleanPath = path.join(dir, "clean.mp4");
  const graphInput = {
    layout,
    beats,
    duration,
    assPath,
    hasAudio: probed.hasAudio,
  };

  try {
    await encode(
      dir,
      "filter.txt",
      sourcePath,
      popPath,
      outputPath,
      composedGraph({ ...graphInput, zoom: "animated", sticker: true }),
      duration,
      true,
    );
  } catch {
    try {
      await encode(
        dir,
        "filter.txt",
        sourcePath,
        popPath,
        outputPath,
        composedGraph({ ...graphInput, zoom: "stepped", sticker: true }),
        duration,
        true,
      );
    } catch (error) {
      try {
        await encode(
          dir,
          "filter.txt",
          sourcePath,
          popPath,
          outputPath,
          composedGraph({ ...graphInput, zoom: "stepped", sticker: false }),
          duration,
          true,
        );
      } catch {
        const detail = error instanceof Error ? error.message.split("\n").at(-1) : "";
        throw new VerticalEditError(
          detail ? `세로 편집에 실패했습니다. ${detail}` : "세로 편집에 실패했습니다.",
        );
      }
    }
  }

  try {
    await encode(
      dir,
      "filter-clean.txt",
      sourcePath,
      popPath,
      cleanPath,
      cleanGraph(duration, probed.hasAudio),
      duration,
      false,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n").at(-1) : "";
    throw new VerticalEditError(
      detail ? `클린 버전을 만들지 못했습니다. ${detail}` : "클린 버전을 만들지 못했습니다.",
    );
  }

  return {
    id,
    notice:
      "상단 훅은 검은 스티커 위의 굵은 제목이고, 핵심 단어만 연두색입니다. 하단 자막은 두꺼운 외곽선으로 올렸습니다.",
  };
}

async function encode(
  dir: string,
  filterName: string,
  sourcePath: string,
  popPath: string,
  outputPath: string,
  graph: string,
  duration: number,
  withSfx: boolean,
): Promise<void> {
  const filterPath = path.join(dir, filterName);
  await writeFile(filterPath, graph, "utf8");
  const args = ["-y", "-i", sourcePath];
  if (withSfx) args.push("-i", popPath);
  args.push(
    "-filter_complex_script",
    filterPath,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-t",
    duration.toFixed(2),
    outputPath,
  );
  await runCommand(ffmpegBinary(), args, 180000);
}

function layoutFor(aspect: number): { videoH: number; videoY: number } {
  if (aspect >= 1.2) return { videoH: 405, videoY: 400 };
  return { videoH: 760, videoY: 260 };
}

function composedGraph(input: {
  layout: { videoH: number; videoY: number };
  beats: PaceBeat[];
  duration: number;
  assPath: string;
  hasAudio: boolean;
  zoom: "animated" | "stepped";
  sticker: boolean;
}): string {
  const { videoH, videoY } = input.layout;
  const fitted = `[0:v]fps=30,scale=${CANVAS_W}:${videoH}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${videoH},setsar=1[base]`;
  const zoomed =
    input.zoom === "animated"
      ? `[base]${zoompan(input.beats, videoH)}[zoomed]`
      : steppedZoom(input.beats, videoH);
  const framed = `[zoomed]pad=${CANVAS_W}:${CANVAS_H}:0:${videoY}:color=0x1C1915[framed]`;
  const captions = captionChain({
    assPath: input.assPath,
    duration: input.duration,
    videoY,
    sticker: input.sticker,
  });
  const audio = audioChain(input.beats, input.duration, input.hasAudio);
  return [fitted, zoomed, framed, ...captions, audio].join(";");
}

function cleanGraph(duration: number, hasAudio: boolean): string {
  const video = `[0:v]fps=30,scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[v]`;
  const audio = hasAudio
    ? `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${duration.toFixed(2)}[a]`
    : `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${duration.toFixed(2)}[a]`;
  return `${video};${audio}`;
}

function zoompan(beats: PaceBeat[], videoH: number): string {
  let expr = "1";
  for (const beat of [...beats].reverse()) {
    const span = Math.max(0.4, beat.endSec - beat.startSec);
    const from = beat.zoom === "in" ? 1 : 1.18;
    const to = beat.zoom === "in" ? 1.18 : 1;
    const piece = `${from}+(${to}-${from})*(time-${beat.startSec.toFixed(2)})/${span.toFixed(2)}`;
    expr = `if(between(time,${beat.startSec.toFixed(2)},${beat.endSec.toFixed(2)}),${piece},${expr})`;
  }
  const escaped = expr.replaceAll(",", "\\,");
  return `zoompan=z='${escaped}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${CANVAS_W}x${videoH}:fps=30`;
}

function steppedZoom(beats: PaceBeat[], videoH: number): string {
  if (beats.length < 2) {
    const zoom = beats[0]?.zoom === "out" ? 1 : 1.22;
    return `[base]scale=${even(CANVAS_W * zoom)}:${even(videoH * zoom)},crop=${CANVAS_W}:${videoH}[zoomed]`;
  }

  const splits = beats.map((_, index) => `[s${index}]`).join("");
  const pieces = beats.map((beat, index) => {
    const zoom = beat.zoom === "in" ? 1.22 : 1;
    const width = even(CANVAS_W * zoom);
    const height = even(videoH * zoom);
    return `[s${index}]trim=start=${beat.startSec.toFixed(2)}:end=${beat.endSec.toFixed(2)},setpts=PTS-STARTPTS,scale=${width}:${height},crop=${CANVAS_W}:${videoH}[b${index}]`;
  });
  const concat = beats.map((_, index) => `[b${index}]`).join("");
  return `[base]split=${beats.length}${splits};${pieces.join(";")};${concat}concat=n=${beats.length}:v=1:a=0[zoomed]`;
}

function captionChain(input: {
  assPath: string;
  duration: number;
  videoY: number;
  sticker: boolean;
}): string[] {
  const subs = `subtitles='${ffmpegPath(input.assPath)}':fontsdir='${ffmpegPath("C:/Windows/Fonts")}'`;
  if (!input.sticker) return [`[framed]${subs}[v]`];

  const stickerH = 168;
  const stickerW = 620;
  const stickerY = Math.max(16, Math.round((input.videoY - stickerH) / 2));
  const radius = 32;
  const alpha =
    `if(lte(hypot(max(abs(X-W/2)-(W/2-${radius})\\,0)\\,max(abs(Y-H/2)-(H/2-${radius})\\,0))\\,${radius})\\,alpha(X\\,Y)\\,0)`;
  return [
    `color=c=black@0.86:s=${stickerW}x${stickerH}:d=${input.duration.toFixed(2)},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[sticker]`,
    `[framed][sticker]overlay=x=(W-w)/2:y=${stickerY}:format=auto[stuck]`,
    `[stuck]${subs}[v]`,
  ];
}

function audioChain(beats: PaceBeat[], duration: number, hasAudio: boolean): string {
  const speech = hasAudio
    ? `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${duration.toFixed(2)}[speech]`
    : `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${duration.toFixed(2)}[speech]`;

  const hits = beats.filter((beat) => beat.sfxSec != null);
  if (hits.length === 0) return `${speech};[speech]anull[a]`;
  if (hits.length === 1) {
    const delay = Math.max(0, Math.round((hits[0].sfxSec ?? 0) * 1000));
    return `${speech};[1:a]adelay=${delay}|${delay},volume=0.42[s0];[speech][s0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  }

  const split = hits.map((_, index) => `[p${index}]`).join("");
  const delayed = hits.map((beat, index) => {
    const delay = Math.max(0, Math.round((beat.sfxSec ?? 0) * 1000));
    return `[p${index}]adelay=${delay}|${delay},volume=0.42[s${index}]`;
  });
  const mix = ["[speech]", ...hits.map((_, index) => `[s${index}]`)].join("");
  return [
    speech,
    `[1:a]asplit=${hits.length}${split}`,
    ...delayed,
    `${mix}amix=inputs=${hits.length + 1}:duration=first:dropout_transition=0:normalize=0[a]`,
  ].join(";");
}

function scaleBeats(beats: PaceBeat[], plannedSec: number, fileSec: number): PaceBeat[] {
  const scale = Math.abs(fileSec - plannedSec) < 0.45 ? 1 : fileSec / plannedSec;
  const scaled = beats.map((beat) => ({
    ...beat,
    startSec: round2(beat.startSec * scale),
    endSec: round2(beat.endSec * scale),
    sfxSec: beat.sfxSec == null ? null : round2(beat.sfxSec * scale),
  }));
  scaled[0].startSec = 0;
  scaled[scaled.length - 1].endSec = round2(fileSec);
  return scaled;
}

function scaleTitles(titles: HookTitle[], plannedSec: number, fileSec: number): HookTitle[] {
  const scale = Math.abs(fileSec - plannedSec) < 0.45 ? 1 : fileSec / plannedSec;
  const scaled = titles.map((title) => ({
    ...title,
    startSec: round2(title.startSec * scale),
    endSec: round2(Math.max(title.startSec * scale + 0.4, title.endSec * scale)),
  }));
  scaled[0].startSec = 0;
  scaled[scaled.length - 1].endSec = round2(fileSec);
  return scaled;
}

function buildAss(
  titles: HookTitle[],
  beats: PaceBeat[],
  layout: { videoH: number; videoY: number },
  duration: number,
): string {
  const stickerH = 168;
  const stickerY = Math.max(16, Math.round((layout.videoY - stickerH) / 2));
  const titleY = Math.round(stickerY + stickerH / 2);
  const bottomH = CANVAS_H - layout.videoY - layout.videoH;
  const captionY = layout.videoY + layout.videoH + Math.round(bottomH / 2);
  const events = [
    ...titles.map(
      (title) =>
        `Dialogue: 0,${assTime(title.startSec)},${assTime(Math.min(duration, title.endSec))},Title,,0,0,0,,{\\an5\\pos(360,${titleY})}${hookText(title.hook, title.keyword)}`,
    ),
    ...beats.map(
      (beat) =>
        `Dialogue: 1,${assTime(beat.startSec)},${assTime(Math.min(duration, beat.endSec))},Cap,,0,0,0,,{\\an5\\pos(360,${captionY})}${colorize(beat.caption || beat.keyword, beat.keyword, "&H004AE1FF")}`,
    ),
  ];

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 720",
    "PlayResY: 1280",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Title,Malgun Gothic,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,5,24,24,24,1",
    "Style: Cap,Malgun Gothic,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,24,24,24,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

function hookText(hook: string, keyword: string): string {
  const lines = splitHook(shortTitle(hook), keyword);
  return lines.map((line) => colorize(line, keyword, "&H004AFFD6")).join("\\N");
}

function shortTitle(hook: string): string {
  const compact = hook.replace(/\s+/g, " ").trim();
  const chars = Array.from(compact);
  return chars.length <= 15 ? compact : chars.slice(0, 15).join("").trim();
}

function splitHook(hook: string, keyword: string): string[] {
  if (Array.from(hook).length <= 8) return [hook];
  const at = keyword ? hook.indexOf(keyword) : -1;
  if (at > 0) {
    const left = hook.slice(0, at).trim();
    const right = hook.slice(at).trim();
    if (left && right && Array.from(left).length <= 9 && Array.from(right).length <= 9) {
      return [left, right];
    }
  }
  const space = hook.indexOf(" ");
  if (space > 0 && space < hook.length - 1) {
    return [hook.slice(0, space), hook.slice(space + 1)];
  }
  const mid = Math.ceil(Array.from(hook).length / 2);
  const chars = Array.from(hook);
  return [chars.slice(0, mid).join(""), chars.slice(mid).join("")];
}

function colorize(text: string, keyword: string, color: string): string {
  const safe = assEscape(text);
  const key = assEscape(keyword.replace(/\s+/g, ""));
  if (!key || !safe.includes(key)) return safe;
  return safe.replace(key, `{\\c${color}&}${key}{\\c&H00FFFFFF&}`);
}

function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const centi = Math.min(99, Math.round((clamped - whole) * 100));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remain = whole % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}.${String(centi).padStart(2, "0")}`;
}

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
