"use client";

import { useState, type FormEvent } from "react";
import { readStoredGeminiKey } from "@/app/components/api-settings";
import { ResultCard } from "@/app/components/result-card";
import { Spinner } from "@/app/components/spinner";
import type { RenderJob } from "@/lib/render-types";
import { SHORTS_PROGRESS } from "@/lib/shorts-progress";
import type { ConvertResult, DurationSec, EditStyle, SourceKind } from "@/lib/types";
import { DURATION_OPTIONS } from "@/lib/types";

const EDIT_STYLES: { id: EditStyle; label: string; help: string }[] = [
  {
    id: "continuous",
    label: "원컷 몰입형",
    help: "가장 재미있는 연속된 30~60초 구간을 잘라내어 대사 흐름과 현장감을 살립니다.",
  },
  {
    id: "highlight",
    label: "하이라이트 요약형",
    help: "영상 전체(초/중/후반)의 핵심 하이라이트만 10~15초씩 숏폼으로 교차 편집합니다.",
  },
];

const SAMPLE_TRANSCRIPT = `대부분의 사람은 영상을 길게 만들수록 정보가 더 전달된다고 생각합니다. 그런데 시청자는 처음 3초 안에 스크롤을 멈출지를 결정합니다. 롱폼에서 반응이 좋았던 구간을 보면 공통점이 있습니다. 숫자, 실수한 지점, 그리고 바로 따라 할 수 있는 행동 하나입니다. 예를 들어 첫 문장만 바꿨더니 평균 시청 시간이 1.8배 늘었습니다. 핵심은 전체를 요약하는 게 아니라, 한 가지 주장만 30초 안에 끝내는 것입니다. 마지막에는 다음 행동 한 줄을 남겨야 저장이 늘어납니다.`;

export function ConverterStudio() {
  const [source, setSource] = useState<SourceKind>("url");
  const [url, setUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [durationSec, setDurationSec] = useState<DurationSec>(30);
  const [editStyle, setEditStyle] = useState<EditStyle>("continuous");
  const [openHelp, setOpenHelp] = useState<EditStyle | null>("continuous");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [autoRender, setAutoRender] = useState(false);
  const [renderToken, setRenderToken] = useState("");
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [readyJob, setReadyJob] = useState<RenderJob | null>(null);
  const [readyMessage, setReadyMessage] = useState<string | null>(null);

  const value = source === "url" ? url : transcript;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setReadyJob(null);
    setReadyMessage(null);
    setResult(null);
    setAutoRender(false);

    try {
      if (source === "url") {
        const outcome = await streamYouTubeShort(
          value,
          durationSec,
          editStyle,
          readStoredGeminiKey(),
          setProgressMessage,
        );
        setReadyMessage(outcome.message);
        setReadyJob(outcome.job);
        setRenderToken(`${Date.now()}`);
        setResult(outcome.result);
        return;
      }

      setProgressMessage(SHORTS_PROGRESS[1]);
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          value,
          durationSec,
          editStyle,
          ...(readStoredGeminiKey() ? { apiKey: readStoredGeminiKey() } : {}),
        }),
      });
      const data = (await response.json()) as ConvertResult & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "변환에 실패했습니다.");
        return;
      }
      setRenderToken(`${Date.now()}`);
      setResult(data);
    } catch (error) {
      setError(visibleError(error));
    } finally {
      setPending(false);
      setProgressMessage(null);
    }
  }

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <form
        onSubmit={onSubmit}
        className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_-32px_rgba(28,25,21,0.45)] sm:p-6"
      >
        <div className="grid grid-cols-2 rounded-full bg-paper p-1 text-sm font-medium">
          <SourceTab
            active={source === "url"}
            onClick={() => setSource("url")}
            label="영상 URL"
          />
          <SourceTab
            active={source === "transcript"}
            onClick={() => setSource("transcript")}
            label="텍스트 / 자막"
          />
        </div>

        {source === "url" ? (
          <div className="mt-5">
            <label htmlFor="video-url" className="text-sm font-medium text-ink">
              유튜브 롱폼 주소
            </label>
            <input
              id="video-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="mt-2 w-full rounded-2xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted/70 focus:ring-4"
            />
            <p className="mt-2 text-xs leading-5 text-muted">
              원본 영상과 자막을 받은 뒤, 고른 구간을 9:16 쇼츠로 이어서 자릅니다.
            </p>
          </div>
        ) : (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="transcript" className="text-sm font-medium text-ink">
                자막 또는 대본
              </label>
              <button
                type="button"
                onClick={() => setTranscript(SAMPLE_TRANSCRIPT)}
                className="text-xs font-medium text-accent"
              >
                예시 넣기
              </button>
            </div>
            <textarea
              id="transcript"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              rows={10}
              placeholder="롱폼 자막을 붙여 넣으세요. 문장마다 줄바꿈해도 됩니다."
              className="mt-2 w-full resize-y rounded-2xl border border-line bg-paper px-4 py-3 text-sm leading-6 text-ink outline-none ring-accent/30 placeholder:text-muted/70 focus:ring-4"
            />
          </div>
        )}

        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-ink">목표 길이</legend>
          <div className="mt-2 flex gap-2">
            {DURATION_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDurationSec(option)}
                aria-pressed={durationSec === option}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  durationSec === option
                    ? "bg-ink text-white"
                    : "bg-paper text-muted hover:text-ink"
                }`}
              >
                {option}초
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-ink">편집 스타일</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {EDIT_STYLES.map((style) => (
              <div key={style.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditStyle(style.id);
                    setOpenHelp(style.id);
                  }}
                  aria-pressed={editStyle === style.id}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    editStyle === style.id ? "bg-ink text-white" : "bg-paper text-muted hover:text-ink"
                  }`}
                >
                  {style.label}
                </button>
                <button
                  type="button"
                  aria-label={`${style.label} 설명`}
                  aria-expanded={openHelp === style.id}
                  aria-controls={`style-help-${style.id}`}
                  onClick={() => setOpenHelp((current) => (current === style.id ? null : style.id))}
                  className="grid size-7 place-items-center rounded-full border border-line text-xs font-semibold text-muted"
                >
                  ?
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {EDIT_STYLES.map((style) => (
              <p
                key={style.id}
                id={`style-help-${style.id}`}
                className={`rounded-2xl px-3 py-2 text-xs leading-5 ${
                  openHelp === style.id ? "bg-accent-soft text-ink" : "bg-paper text-muted"
                }`}
              >
                <span className="font-semibold">? {style.label}.</span> {style.help}
              </p>
            ))}
          </div>
        </fieldset>

        {error ? (
          <p className="mt-4 rounded-2xl bg-accent-soft px-4 py-3 text-sm text-accent">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || value.trim().length === 0}
          aria-busy={pending}
          className={`mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-accent-ink transition hover:bg-[#a93624] disabled:cursor-not-allowed ${pending ? "" : "disabled:opacity-50"}`}
        >
          {pending ? <Spinner /> : null}
          <span role="status">{buttonLabel(pending, source, progressMessage)}</span>
        </button>
      </form>

      <div>
        {pending && progressMessage ? (
          <LoadingResult message={progressMessage} />
        ) : result ? (
          <ResultCard
            key={renderToken}
            result={result}
            autoRender={autoRender}
            renderToken={renderToken}
            initialJob={readyJob}
            readyMessage={readyMessage}
          />
        ) : (
          <EmptyResult />
        )}
      </div>
    </div>
  );
}

function SourceTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-2 transition ${
        active ? "bg-card text-ink shadow-sm" : "text-muted"
      }`}
    >
      {label}
    </button>
  );
}

function visibleError(error: unknown): string {
  if (error instanceof Error && error.message && !/fetch|network/i.test(error.message)) {
    return error.message;
  }
  return "서버에 연결하지 못했습니다.";
}

function buttonLabel(pending: boolean, source: SourceKind, progressMessage: string | null): string {
  if (pending) return progressMessage ?? SHORTS_PROGRESS[0];
  return source === "url" ? "영상 받아 쇼츠로 자르기" : "구간만 뽑아 보기";
}

function LoadingResult({ message }: { message: string }) {
  return (
    <div
      className="grid min-h-[420px] place-items-center rounded-3xl border border-dashed border-line bg-card/70 px-6 py-16"
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <Spinner className="size-11 border-[3px] text-accent" />
        <p className="text-sm leading-6 font-medium text-ink">{message}</p>
      </div>
    </div>
  );
}

async function streamYouTubeShort(
  value: string,
  durationSec: DurationSec,
  editStyle: EditStyle,
  apiKey: string,
  onProgress: (message: string) => void,
): Promise<{ result: ConvertResult; job: RenderJob; message: string }> {
  onProgress(SHORTS_PROGRESS[0]);
  const response = await fetch("/api/shorts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value,
      durationSec,
      editStyle,
      ...(apiKey ? { apiKey } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "쇼츠를 만들지 못했습니다.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: { result: ConvertResult; job: RenderJob; message: string } | null = null;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        type?: string;
        message?: string;
        result?: ConvertResult;
        job?: RenderJob;
      };
      if (event.type === "progress" && event.message) onProgress(event.message);
      if (event.type === "error") throw new Error(event.message ?? "쇼츠를 만들지 못했습니다.");
      if (event.type === "done" && event.result && event.job && event.message) {
        outcome = { result: event.result, job: event.job, message: event.message };
      }
    }
  }

  if (!outcome) throw new Error("쇼츠 결과를 받지 못했습니다.");
  return outcome;
}

function EmptyResult() {
  const placeholders = [
    { label: "구간", body: "가장 센 30초~1분의 시작과 끝 시간을 고릅니다." },
    { label: "3초 훅", body: "첫 문장으로 시선을 멈추고, 끝이 그 문장으로 다시 닫힙니다." },
    { label: "페이싱", body: "2~3초마다 강조 단어, 줌, 효과음 시점을 붙입니다." },
  ];

  return (
    <div className="rounded-3xl border border-dashed border-line bg-card/70 px-6 py-6">
      <p className="text-xs font-medium tracking-[0.16em] text-muted uppercase">
        결과 미리보기
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        변환하면 이 카드에 정리됩니다
      </h2>
      <ul className="mt-5 space-y-3">
        {placeholders.map((item) => (
          <li key={item.label} className="rounded-2xl border border-line bg-paper px-4 py-3">
            <p className="text-sm font-semibold text-ink">{item.label}</p>
            <p className="mt-1 text-sm leading-6 text-muted">{item.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
