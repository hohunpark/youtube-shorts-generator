import type { DurationSec, PaceBeat } from "@/lib/types";

export type HookTitle = {
  startSec: number;
  endSec: number;
  hook: string;
  keyword: string;
};

export type RenderRequest = {
  videoId: string;
  title: string;
  hook: string;
  hookKeyword: string;
  loopLine: string;
  durationSec: DurationSec;
  clipStartSec: number;
  clipEndSec: number;
  beats: PaceBeat[];
  titles?: HookTitle[];
};

export type RenderBeat = {
  timeRange: string;
  keyword: string;
  zoom: PaceBeat["zoom"];
  sfxLabel: string;
  caption: string;
};

export type RenderJob = {
  id: string;
  status: "ready";
  durationSec: DurationSec;
  videoUrl: string;
  cleanVideoUrl: string;
  mimeType: "video/mp4";
  notice: string;
  clipLabel: string;
  beats: RenderBeat[];
};
