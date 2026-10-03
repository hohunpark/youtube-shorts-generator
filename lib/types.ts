export const DURATION_OPTIONS = [30, 45, 60] as const;

export type DurationSec = (typeof DURATION_OPTIONS)[number];

export type SourceKind = "url" | "transcript";

export type EditStyle = "continuous" | "highlight";

export type PipelineState = "done" | "pending";

export type PipelineStep = {
  id: "ingest" | "captions" | "rank" | "compose";
  label: string;
  detail: string;
  state: PipelineState;
};

export type ZoomDirection = "in" | "out";

export type PaceBeat = {
  startSec: number;
  endSec: number;
  keyword: string;
  zoom: ZoomDirection;
  sfxSec: number | null;
  caption: string;
};

export type SceneGuide = {
  label: string;
  timeRange: string;
  direction: string;
  line: string;
  keywords: string[];
};

export type ClipOption = {
  title: string;
  hook: string;
  hookKeyword: string;
  loopLine: string;
  startSec: number;
  endSec: number;
  beats: PaceBeat[];
  spoken: string;
  scenes: SceneGuide[];
  readSeconds: number;
};

export type ConvertResult = {
  status: "ready" | "needs_transcript";
  sourceLabel: string;
  videoId: string | null;
  title: string | null;
  hook: string | null;
  script: string | null;
  durationSec: DurationSec;
  readSeconds: number | null;
  scenes: SceneGuide[];
  clipStartSec: number | null;
  clipEndSec: number | null;
  loopLine: string | null;
  beats: PaceBeat[];
  options: ClipOption[];
  editStyle: EditStyle;
  hasSource: boolean;
  notice: string | null;
  pipeline: PipelineStep[];
};

export function isDurationSec(value: unknown): value is DurationSec {
  return value === 30 || value === 45 || value === 60;
}

export function isSourceKind(value: unknown): value is SourceKind {
  return value === "url" || value === "transcript";
}

export function isEditStyle(value: unknown): value is EditStyle {
  return value === "continuous" || value === "highlight";
}
