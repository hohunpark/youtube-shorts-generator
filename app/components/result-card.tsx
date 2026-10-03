"use client";

import { useMemo, useState } from "react";
import { VideoPreview } from "@/app/components/video-preview";
import type { RenderJob } from "@/lib/render-types";
import type { ConvertResult } from "@/lib/types";

export function ResultCard({
  result,
  autoRender = false,
  renderToken,
  initialJob = null,
  readyMessage = null,
}: {
  result: ConvertResult;
  autoRender?: boolean;
  renderToken?: string;
  initialJob?: RenderJob | null;
  readyMessage?: string | null;
}) {
  if (result.status === "needs_transcript") {
    return <PendingCard result={result} />;
  }

  return (
    <ReadyCard
      result={result}
      autoRender={autoRender}
      renderToken={renderToken}
      initialJob={initialJob}
      readyMessage={readyMessage}
    />
  );
}

function ReadyCard({
  result,
  autoRender,
  renderToken,
  initialJob,
  readyMessage,
}: {
  result: ConvertResult;
  autoRender: boolean;
  renderToken?: string;
  initialJob: RenderJob | null;
  readyMessage: string | null;
}) {
  const options = result.options.length > 0 ? result.options : [];
  const joined = result.editStyle === "highlight" && options.length > 1 && Boolean(initialJob);
  const [view, setView] = useState<"joined" | number>(joined ? "joined" : 0);
  const optionIndex = view === "joined" ? 0 : view;
  const active = options[optionIndex] ?? options[0];
  const [jobs, setJobs] = useState<(RenderJob | null)[]>(() =>
    joined ? options.map(() => null) : [initialJob],
  );
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const shownJob = view === "joined" ? initialJob : (jobs[optionIndex] ?? null);
  const previewRequest = useMemo(
    () =>
      result.hasSource && result.videoId && active && active.beats.length > 0
        ? {
            videoId: result.videoId,
            title: active.title,
            hook: active.hook,
            hookKeyword: active.hookKeyword,
            loopLine: active.loopLine,
            durationSec: result.durationSec,
            clipStartSec: active.startSec,
            clipEndSec: active.endSec,
            beats: active.beats,
          }
        : null,
    [active, result.durationSec, result.hasSource, result.videoId],
  );
  const [copied, setCopied] = useState(false);

  async function copyScript() {
    if (!active?.spoken) return;
    await navigator.clipboard.writeText(active.spoken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function chooseOption(next: number) {
    setView(next);
    setRenderError(null);
    if (!result.hasSource || !result.videoId || jobs[next]) return;
    const option = options[next];
    if (!option) return;
    setRendering(true);
    try {
      const response = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: result.videoId,
          title: option.title,
          hook: option.hook,
          hookKeyword: option.hookKeyword,
          loopLine: option.loopLine,
          durationSec: result.durationSec,
          clipStartSec: option.startSec,
          clipEndSec: option.endSec,
          beats: option.beats,
        }),
      });
      const data = (await response.json()) as RenderJob & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "이 구간을 쇼츠로 만들지 못했습니다.");
      setJobs((current) => {
        const copy = [...current];
        copy[next] = data;
        return copy;
      });
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "이 구간을 쇼츠로 만들지 못했습니다.");
    } finally {
      setRendering(false);
    }
  }

  return (
    <article className="overflow-hidden rounded-3xl border border-line bg-card shadow-[0_20px_50px_-36px_rgba(28,25,21,0.55)]">
      {result.notice ? (
        <p className="border-b border-line bg-accent-soft px-6 py-3 text-sm leading-6 text-accent">
          {result.notice}
        </p>
      ) : null}
      <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <p className="text-xs font-medium tracking-[0.16em] text-accent uppercase">
            숏폼 대본
          </p>
          <h2 className="mt-2 text-2xl leading-snug font-semibold tracking-tight text-ink">
            {active?.title ?? result.title}
          </h2>
        </div>
        <div className="shrink-0 rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent">
          {view === "joined"
            ? "교차 편집"
            : active
              ? `${formatRange(active.startSec, active.endSec)}`
              : `목표 ${result.durationSec}초`}
        </div>
      </header>

      {options.length > 1 ? (
        <div className="flex flex-wrap gap-2 border-b border-line px-6 py-4">
          {joined ? (
            <button
              type="button"
              onClick={() => setView("joined")}
              aria-pressed={view === "joined"}
              className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                view === "joined" ? "bg-ink text-white" : "bg-paper text-muted"
              }`}
            >
              교차 편집
              <span className="mt-0.5 block text-[11px] font-normal opacity-80">초·중·후반</span>
            </button>
          ) : null}
          {options.map((option, index) => (
            <button
              key={`${option.startSec}-${option.endSec}`}
              type="button"
              onClick={() => void chooseOption(index)}
              aria-pressed={view === index}
              disabled={rendering}
              className={`rounded-full px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${
                view === index ? "bg-ink text-white" : "bg-paper text-muted"
              }`}
            >
              {index + 1}번 구간
              <span className="mt-0.5 block font-mono text-[11px] font-normal opacity-80">
                {formatRange(option.startSec, option.endSec)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-6 px-6 py-6">
        <section>
          <h3 className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
            3초 훅
          </h3>
          <p className="mt-2 text-lg leading-8 font-medium text-ink">{active?.hook ?? result.hook}</p>
        </section>

        {active?.loopLine || result.loopLine ? (
          <section>
            <h3 className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
              루프 마무리
            </h3>
            <p className="mt-2 text-lg leading-8 font-medium text-ink">
              {active?.loopLine ?? result.loopLine}
            </p>
          </section>
        ) : null}

        <section className="rounded-2xl bg-paper px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
              구간 자막
            </h3>
            <button
              type="button"
              onClick={copyScript}
              className="rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink transition hover:border-ink/20"
            >
              {copied ? "복사됨" : "대본 복사"}
            </button>
          </div>
          <p className="mt-3 text-[15px] leading-7 text-ink">{active?.spoken ?? result.script}</p>
          <p className="mt-3 text-xs text-muted">
            길이 약 {active?.readSeconds ?? result.readSeconds}초 · {result.sourceLabel}
          </p>
        </section>

        <section>
          <h3 className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
            2~3초 페이싱
          </h3>
          <ol className="mt-3 divide-y divide-line">
            {(active?.scenes ?? result.scenes).map((scene, index) => (
              <li key={`${scene.label}-${index}`} className="grid gap-2 py-3 sm:grid-cols-[88px_1fr]">
                <div>
                  <p className="text-sm font-semibold text-ink">{scene.label}</p>
                  <p className="font-mono text-xs text-muted">{scene.timeRange}</p>
                </div>
                <div>
                  <p className="text-sm leading-6 text-ink">{scene.line}</p>
                  {scene.keywords.length > 0 ? (
                    <p className="mt-2 flex flex-wrap gap-1.5">
                      {scene.keywords.map((keyword) => (
                        <span
                          key={keyword}
                          className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
                        >
                          {keyword}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm leading-6 text-muted">{scene.direction}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {previewRequest ? (
          <>
            <VideoPreview
              key={shownJob?.id ?? `pending-${String(view)}`}
              autoStart={autoRender && !initialJob}
              startToken={renderToken}
              request={previewRequest}
              initialJob={shownJob}
              autoPlay={Boolean(shownJob) && (view === "joined" || view === 0)}
              readyMessage={view === "joined" || view === 0 ? readyMessage : null}
              rendering={view !== "joined" && rendering && !jobs[optionIndex]}
            />
            {renderError ? (
              <p className="rounded-2xl bg-accent-soft px-4 py-3 text-sm text-accent">{renderError}</p>
            ) : null}
          </>
        ) : null}
      </div>

      <PipelineTrail pipeline={result.pipeline} />
    </article>
  );
}

function PendingCard({ result }: { result: ConvertResult }) {
  return (
    <article className="overflow-hidden rounded-3xl border border-line bg-card">
      <header className="border-b border-line px-6 py-5">
        <p className="text-xs font-medium tracking-[0.16em] text-accent uppercase">
          파이프라인
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
          {result.sourceLabel}까지 확인했습니다
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">{result.notice}</p>
      </header>
      <PipelineTrail pipeline={result.pipeline} />
    </article>
  );
}

function formatRange(startSec: number, endSec: number): string {
  return `${formatClock(startSec)}–${formatClock(endSec)}`;
}

function formatClock(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remain = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function PipelineTrail({ pipeline }: { pipeline: ConvertResult["pipeline"] }) {
  return (
    <ol className="grid gap-px bg-line sm:grid-cols-4">
      {pipeline.map((step, index) => (
        <li key={step.id} className="bg-card px-4 py-3">
          <p className="text-[11px] font-medium tracking-[0.12em] text-muted uppercase">
            0{index + 1} {step.state === "done" ? "완료" : "대기"}
          </p>
          <p className="mt-1 text-sm font-medium text-ink">{step.label}</p>
          <p className="mt-1 text-xs leading-5 text-muted">{step.detail}</p>
        </li>
      ))}
    </ol>
  );
}
