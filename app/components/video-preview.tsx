"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@/app/components/spinner";
import type { RenderJob, RenderRequest } from "@/lib/render-types";

const inflightRenders = new Map<string, Promise<RenderOutcome>>();

type RenderOutcome = { job: RenderJob } | { error: string };

async function requestRender(request: RenderRequest): Promise<RenderOutcome> {
  try {
    const response = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const data = (await response.json()) as RenderJob & { error?: string };
    if (!response.ok) {
      return { error: data.error ?? "영상 미리보기를 만들지 못했습니다." };
    }
    return { job: data };
  } catch {
    return { error: "서버에 연결하지 못했습니다." };
  }
}

export function VideoPreview({
  request,
  autoStart = false,
  startToken,
  initialJob = null,
  autoPlay = false,
  readyMessage = null,
  rendering = false,
}: {
  request: RenderRequest;
  autoStart?: boolean;
  startToken?: string;
  initialJob?: RenderJob | null;
  autoPlay?: boolean;
  readyMessage?: string | null;
  rendering?: boolean;
}) {
  const [pending, setPending] = useState(autoStart && !initialJob);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<RenderJob | null>(initialJob);

  const applyOutcome = useCallback((outcome: RenderOutcome) => {
    if ("job" in outcome) {
      setError(null);
      setJob(outcome.job);
    } else {
      setJob(null);
      setError(outcome.error);
    }
    setPending(false);
  }, []);

  useEffect(() => {
    if (!autoStart || !startToken) return;
    let ignore = false;

    let task = inflightRenders.get(startToken);
    if (!task) {
      task = requestRender(request);
      inflightRenders.set(startToken, task);
    }

    void task.then((outcome) => {
      if (!ignore) applyOutcome(outcome);
    });

    return () => {
      ignore = true;
    };
  }, [applyOutcome, autoStart, request, startToken]);

  async function generate() {
    setPending(true);
    setError(null);
    applyOutcome(await requestRender(request));
  }

  return (
    <section className="space-y-4">
      <button
        type="button"
        onClick={generate}
        disabled={pending}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#3a342c] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending ? <Spinner /> : null}
        {pending ? "9:16 세로 화면 크롭 및 줌/자막 렌더링 중..." : "9:16 쇼츠로 편집하기"}
      </button>

      {error ? (
        <p className="rounded-2xl bg-accent-soft px-4 py-3 text-sm text-accent">{error}</p>
      ) : null}

      {rendering ? (
        <div className="grid min-h-[280px] place-items-center rounded-2xl border border-dashed border-line bg-paper" role="status">
          <div className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
            <Spinner className="size-10 border-[3px] text-accent" />
            <p className="text-sm leading-6 font-medium text-ink">
              9:16 세로 화면 크롭 및 줌/자막 렌더링 중...
            </p>
          </div>
        </div>
      ) : job ? (
        <PreviewPlayer job={job} autoPlay={autoPlay} readyMessage={readyMessage} />
      ) : null}
    </section>
  );
}

function PreviewPlayer({
  job,
  autoPlay,
  readyMessage,
}: {
  job: RenderJob;
  autoPlay: boolean;
  readyMessage: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!autoPlay) return;
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => undefined);
  }, [autoPlay, job.videoUrl]);

  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      {readyMessage ? (
        <p className="mb-3 text-sm font-medium text-ink" role="status">
          {readyMessage}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
          숏폼 미리보기
        </p>
        <p className="text-xs font-medium text-ink">{job.clipLabel} · MP4</p>
      </div>

      <div className="mx-auto mt-4 w-full max-w-[260px] overflow-hidden rounded-2xl bg-ink shadow-[0_16px_40px_-28px_rgba(28,25,21,0.8)]">
        <div className="aspect-[9/16]">
          {job.videoUrl ? (
            <video
              ref={videoRef}
              key={job.videoUrl}
              className="h-full w-full bg-black object-cover"
              controls
              autoPlay={autoPlay}
              playsInline
              preload="auto"
              src={job.videoUrl}
            />
          ) : (
            <div className="grid h-full place-items-center px-5 text-center text-sm leading-6 text-white/80">
              플레이어는 연결돼 있습니다. 미리보기 파일이 생기면 이 자리에서 재생됩니다.
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        <a
          href={`${job.videoUrl}?download=1`}
          className="flex h-11 items-center justify-center rounded-full bg-accent px-4 text-center text-sm font-semibold text-accent-ink"
        >
          자막·제목 포함 쇼츠 다운로드 (MP4)
        </a>
        <a
          href={`${job.cleanVideoUrl}&download=1`}
          className="flex h-11 items-center justify-center rounded-full border border-line bg-card px-4 text-center text-sm font-semibold text-ink"
        >
          클린 버전 다운로드 (자막·제목 없음)
        </a>
      </div>

      <p className="mt-4 text-sm leading-6 text-muted">{job.notice}</p>

      <div className="mt-4 space-y-3">
        {job.beats.map((beat) => (
          <article key={`${beat.timeRange}-${beat.keyword}`} className="rounded-xl bg-card px-3 py-3">
            <p className="text-sm font-semibold text-ink">
              {beat.keyword}{" "}
              <span className="font-mono text-xs font-normal text-muted">{beat.timeRange}</span>
            </p>
            <p className="mt-1 text-sm leading-6 text-ink">{beat.caption}</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {beat.zoom === "in" ? "줌인" : "줌아웃"} · {beat.sfxLabel}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
