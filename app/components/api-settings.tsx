"use client";

import { useState } from "react";

export const GEMINI_KEY_STORAGE = "shorts.geminiApiKey";

export function readStoredGeminiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(GEMINI_KEY_STORAGE)?.trim() ?? "";
}

export function ApiSettings() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

  function toggle() {
    if (!open) {
      const stored = readStoredGeminiKey();
      setKey(stored);
      setSaved(Boolean(stored));
    }
    setOpen((current) => !current);
  }

  function save() {
    const next = key.trim();
    if (next) localStorage.setItem(GEMINI_KEY_STORAGE, next);
    else localStorage.removeItem(GEMINI_KEY_STORAGE);
    setKey(next);
    setSaved(Boolean(next));
    setOpen(false);
  }

  function clear() {
    localStorage.removeItem(GEMINI_KEY_STORAGE);
    setKey("");
    setSaved(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="rounded-full border border-line bg-card px-3 py-2 text-xs font-semibold text-ink"
      >
        ⚙️ API 설정
      </button>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="absolute top-12 right-0 z-20 w-80 rounded-2xl border border-line bg-card p-4 shadow-[0_20px_50px_-32px_rgba(28,25,21,0.55)]"
        >
          <label htmlFor="gemini-key" className="text-sm font-medium text-ink">
            Gemini API Key
          </label>
          <input
            id="gemini-key"
            type="password"
            value={key}
            autoComplete="off"
            onChange={(event) => setKey(event.target.value)}
            placeholder="내 키를 이 브라우저에 저장"
            className="mt-2 w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm text-ink outline-none ring-accent/30 focus:ring-4"
          />
          <p className="mt-2 text-xs leading-5 text-muted">
            {saved
              ? "이 브라우저에 저장한 키로 Gemini를 호출합니다."
              : "비워 두면 서버의 기본 키로 동작합니다. 키는 이 브라우저에만 남습니다."}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              className="rounded-full bg-ink px-3 py-2 text-xs font-semibold text-white"
            >
              저장
            </button>
            <button
              type="button"
              onClick={clear}
              className="rounded-full border border-line px-3 py-2 text-xs font-medium text-muted"
            >
              기본 키로
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
