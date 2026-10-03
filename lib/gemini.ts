import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import type { DurationSec, EditStyle, ZoomDirection } from "@/lib/types";
import { cuesForPrompt, type TimedCue } from "@/lib/timed-text";

const FLASH_MODEL = "gemini-3.5-flash-lite";
const PRO_MODEL = "gemini-3.8-flash";

const MODEL_ALIASES: Record<string, string> = {
  flash: FLASH_MODEL,
  pro: PRO_MODEL,
  "gemini-1.5-flash": FLASH_MODEL,
  "gemini-1.5-flash-latest": FLASH_MODEL,
  "gemini-1.5-pro": PRO_MODEL,
  "gemini-1.5-pro-latest": PRO_MODEL,
};

const BEAT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    startSec: { type: SchemaType.NUMBER },
    endSec: { type: SchemaType.NUMBER },
    keyword: { type: SchemaType.STRING },
    zoom: { type: SchemaType.STRING },
    sfxSec: { type: SchemaType.NUMBER },
    caption: { type: SchemaType.STRING },
  },
  required: ["startSec", "endSec", "keyword", "zoom", "sfxSec", "caption"],
} satisfies Schema;

const OPTION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    startSec: { type: SchemaType.NUMBER },
    endSec: { type: SchemaType.NUMBER },
    hook: { type: SchemaType.STRING },
    hookKeyword: { type: SchemaType.STRING },
    loopLine: { type: SchemaType.STRING },
    beats: { type: SchemaType.ARRAY, items: BEAT_SCHEMA },
  },
  required: ["title", "startSec", "endSec", "hook", "hookKeyword", "loopLine", "beats"],
} satisfies Schema;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    options: { type: SchemaType.ARRAY, items: OPTION_SCHEMA },
  },
  required: ["options"],
} satisfies Schema;

export type GeminiBeat = {
  startSec: number;
  endSec: number;
  keyword: string;
  zoom: ZoomDirection;
  sfxSec: number | null;
  caption: string;
};

export type GeminiOption = {
  title: string;
  startSec: number;
  endSec: number;
  hook: string;
  hookKeyword: string;
  loopLine: string;
  beats: GeminiBeat[];
};

export type GeminiEdit = {
  options: GeminiOption[];
  model: string;
  truncated: boolean;
};

export function resolveGeminiModel(): string {
  const requested = process.env.GEMINI_MODEL?.trim() || "flash";
  return MODEL_ALIASES[requested] ?? requested;
}

export async function planShortsEdit(input: {
  cues: TimedCue[];
  durationSec: DurationSec;
  editStyle?: EditStyle;
  apiKey?: string;
}): Promise<GeminiEdit> {
  const apiKey = input.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiDraftError(
      "GEMINI_API_KEY가 없습니다. .env.local에 키를 넣고 개발 서버를 다시 시작해 주세요.",
    );
  }

  const promptSource = cuesForPrompt(input.cues);
  if (promptSource.text.trim().length < 20) {
    throw new GeminiDraftError("분석할 자막이 너무 짧습니다.");
  }

  const modelName = resolveGeminiModel();
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
    },
  });

  let raw = "";
  try {
    const result = await model.generateContent(
      buildPrompt(promptSource.text, input.durationSec, input.editStyle ?? "continuous"),
    );
    raw = result.response.text();
  } catch (error) {
    throw new GeminiDraftError(geminiErrorMessage(error, modelName));
  }

  const edit = parseEdit(raw);
  return { ...edit, model: modelName, truncated: promptSource.truncated };
}

export class GeminiDraftError extends Error {}

function buildPrompt(source: string, durationSec: number, editStyle: EditStyle): string {
  const piece = Math.min(15, Math.max(10, Math.round(durationSec / 3)));
  const range =
    editStyle === "highlight"
      ? [
          "하이라이트 요약형이다. options는 3개다.",
          "1번은 영상 초반, 2번은 중반, 3번은 후반에서 고른다. 서로 겹치지 않는다.",
          `각 구간 길이는 ${piece}초 안팎이고, 10초에서 15초 사이다.`,
          "세 구간은 나중에 순서대로 이어 붙여 교차 편집한다.",
        ]
      : [
          "원컷 몰입형이다. 가장 임팩트 있는 연속 구간 3개를 options로 반환한다.",
          "1번이 가장 세고, 2번, 3번 순이다. 세 구간은 서로 겹치지 않는다.",
          `startSec와 endSec는 원본 영상 기준 초다. endSec - startSec는 ${Math.max(8, durationSec - 3)}초에서 ${durationSec + 3}초 사이다.`,
        ];

  return [
    "너는 유튜브 롱폼을 쇼츠로 자르는 편집자다.",
    "아래는 타임스탬프가 있는 자막이다. 각 줄은 [시작초-끝초] 대사 형식이다.",
    ...range,
    "자막에 없는 숫자, 사건, 인용은 만들지 않는다.",
    "hook, hookKeyword, loopLine, title, keyword, caption은 모두 한글이다. 원문이 영어여도 그 구간의 뜻을 한국어로 옮기고, 영문 단어를 남기지 않는다.",
    "loopLine은 hook 문장을 그대로 복사하지 않는다. 같은 질문이나 말로 되돌아오는 결론으로 쓴다.",
    "",
    "hook은 화면 상단에 붙는 메인 제목이다. 공백 포함 15자 이내의 강렬한 단문이다.",
    "1줄이 원칙이고, 길어도 2줄이다. 3줄이 되는 장문, 설명문, 접속사로 늘어지는 문장은 금지다.",
    "hookKeyword는 hook 안에 그대로 들어 있는 2~5자 단어다. 화면에서 노란색으로 강조한다.",
    "loopLine은 구간 끝에 띄울 한 문장이다. hook의 말이나 질문을 다시 받아 루프로 닫고, 20~40자다.",
    "title은 카드에 보일 쇼츠 제목이다. 32자 안팎이다.",
    "beats는 구간을 2초에서 3초 단위로 나눈 연출이다. beat의 0초는 그 구간 시작이다.",
    "beats를 이어 붙이면 0초부터 구간 길이까지 빈틈이 없다.",
    "keyword는 그 2~3초 자막에서 키울 말 1~3어절이다.",
    "zoom은 in 또는 out이다. 순서대로 번갈아 쓴다.",
    "sfxSec는 그 beat 안에서 효과음을 넣을 상대 시각이다.",
    "caption은 화면 하단에 실시간으로 바꿀 짧은 자막이다. keyword를 포함하고 12자 안팎이다.",
    "",
    "자막:",
    source,
  ].join("\n");
}

function parseEdit(raw: string): Omit<GeminiEdit, "model" | "truncated"> {
  const parsed = readJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new GeminiDraftError("Gemini 응답을 편집 JSON으로 읽지 못했습니다.");
  }

  const record = parsed as Record<string, unknown>;
  const options = readOptions(record.options);
  if (options.length < 1) {
    throw new GeminiDraftError("Gemini 편집안에 구간, 훅, 루프, 페이싱이 빠져 있습니다.");
  }

  return { options };
}

function readOptions(value: unknown): GeminiOption[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 3).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const option = item as Record<string, unknown>;
    const title = cleanText(option.title, 80);
    const hook = shortHook(cleanText(option.hook, 80));
    const hookKeyword = keywordInside(hook, cleanText(option.hookKeyword, 12));
    const loopLine = cleanText(option.loopLine, 160);
    const startSec = numberValue(option.startSec);
    const endSec = numberValue(option.endSec);
    const beats = readBeats(option.beats);
    if (!title || !hook || !loopLine || startSec == null || endSec == null || beats.length < 2) {
      return [];
    }
    return [{ title, hook, hookKeyword, loopLine, startSec, endSec, beats }];
  });
}

function readBeats(value: unknown): GeminiBeat[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const beat = item as Record<string, unknown>;
    const startSec = numberValue(beat.startSec);
    const endSec = numberValue(beat.endSec);
    const keyword = cleanText(beat.keyword, 24);
    const caption = cleanText(beat.caption, 40);
    if (startSec == null || endSec == null || !keyword) return [];

    const sfxSec = numberValue(beat.sfxSec);
    return [
      {
        startSec,
        endSec,
        keyword,
        zoom: beat.zoom === "out" ? "out" : "in",
        sfxSec,
        caption: caption || keyword,
      },
    ];
  });
}

function readJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function shortHook(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= 15) return value;
  return chars.slice(0, 15).join("").trim();
}

function keywordInside(hook: string, raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  if (compact && hook.includes(compact)) return Array.from(compact).slice(0, 5).join("");
  const token = hook
    .split(/\s+/)
    .sort((a, b) => Array.from(b).length - Array.from(a).length)[0];
  if (token) return Array.from(token).slice(0, 5).join("");
  return Array.from(hook).slice(0, 2).join("");
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function geminiErrorMessage(error: unknown, modelName: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/API_KEY_INVALID|API key not valid/i.test(message)) {
    return "Gemini API 키가 올바르지 않습니다. API 설정에 넣은 키 또는 .env.local의 GEMINI_API_KEY를 확인해 주세요.";
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return "Gemini 요청 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  if (/not found|404/i.test(message)) {
    return `Gemini 모델 ${modelName}을 찾지 못했습니다. .env.local의 GEMINI_MODEL을 확인해 주세요.`;
  }
  return "Gemini가 편집 구간을 고르지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
}
