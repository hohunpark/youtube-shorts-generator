import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "@/lib/command";

export const CLOUD_BLOCK_MESSAGE =
  "클라우드 IP 차단됨: '텍스트 / 자막' 탭을 이용하시거나 쿠키를 설정해주세요";

export async function ensureCookieFile(): Promise<string | null> {
  try {
    const pasted = readEnv("YOUTUBE_COOKIES_TEXT");
    if (pasted) return writeCookieFile(pasted, "YOUTUBE_COOKIES_TEXT");

    const fromFile = readEnv("YOUTUBE_COOKIES") || readEnv("YTDLP_COOKIES");
    if (!fromFile) {
      console.error("[cookies] YOUTUBE_COOKIES_TEXT / YOUTUBE_COOKIES / YTDLP_COOKIES 가 비어 있습니다.");
      return null;
    }
    if (!fromFile.includes("\n") && !fromFile.includes("=") && (await fileExists(fromFile))) return fromFile;
    if (!fromFile.includes("\n") && !fromFile.includes("\t") && (await fileExists(fromFile))) return fromFile;
    return writeCookieFile(fromFile, readEnv("YOUTUBE_COOKIES") ? "YOUTUBE_COOKIES" : "YTDLP_COOKIES");
  } catch (error) {
    console.error("[cookies] 쿠키 파일을 만들지 못했습니다.", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function youtubeCookieHeader(): Promise<string | null> {
  const file = await ensureCookieFile();
  if (!file) return null;

  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const pairs = netscapeRows(text)
    .filter((row) => /youtube\.com|google\.com/i.test(row.domain))
    .map((row) => `${row.name}=${row.value}`);

  if (pairs.length === 0) {
    console.error("[cookies] 쿠키 파일에서 youtube.com 쿠키 헤더를 만들지 못했습니다.");
    return null;
  }
  console.error(`[cookies] Cookie 헤더에 youtube/google 쿠키 ${pairs.length}개를 넣습니다.`);
  return pairs.join("; ");
}

async function writeCookieFile(raw: string, source: string): Promise<string> {
  const normalized = normalizeCookies(raw);
  const rows = netscapeRows(normalized);
  const file = path.join(process.cwd(), ".data", "bin", "youtube-cookies.txt");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, normalized, "utf8");
  const youtube = rows.filter((row) => /youtube\.com|google\.com/i.test(row.domain)).length;
  console.error(
    `[cookies] source=${source} chars=${raw.length} rows=${rows.length} youtubeRows=${youtube} path=${file}`,
  );
  if (rows.length === 0) {
    console.error(`[cookies] Netscape 행을 해석하지 못했습니다. ${cookieHint(raw)}`);
  }
  return file;
}

function normalizeCookies(raw: string): string {
  const text = unescapeCookieText(raw);
  if (text.startsWith("[") || text.startsWith("{")) {
    const fromJson = cookiesFromJson(text);
    if (fromJson) return fromJson;
    console.error("[cookies] JSON 쿠키 파싱에 실패해 Netscape 형식으로 다시 해석합니다.");
  }

  const rows = netscapeRows(text);
  if (rows.length > 0) {
    const lines = ["# Netscape HTTP Cookie File", ...rows.map((row) => row.line)];
    return `${lines.join("\n")}\n`;
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
      const domainName = cookieField(row, ["domain", "Domain"]) || ".youtube.com";
      const httpOnly = row.httpOnly === true || row.httpOnly === "true";
      const domain = httpOnly && !domainName.startsWith("#HttpOnly_") ? `#HttpOnly_${domainName}` : domainName;
      const cookiePath = cookieField(row, ["path", "Path"]) || "/";
      const secure = row.secure === true || row.Secure === true;
      const expiry = Math.floor(Number(row.expirationDate ?? row.expiry ?? 0)) || 0;
      const includeSubdomains = domain.replace(/^#HttpOnly_/, "").startsWith(".") ? "TRUE" : "FALSE";
      lines.push(
        `${domain}\t${includeSubdomains}\t${cookiePath}\t${secure ? "TRUE" : "FALSE"}\t${expiry}\t${name}\t${value}`,
      );
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch (error) {
    console.error("[cookies] JSON.parse 실패", error instanceof Error ? error.message : error);
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

type NetscapeRow = {
  domain: string;
  name: string;
  value: string;
  line: string;
};

function unescapeCookieText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .trim();
}

function netscapeRows(text: string): NetscapeRow[] {
  const rows: NetscapeRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseNetscapeLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

function parseNetscapeLine(line: string): NetscapeRow | null {
  const text = line.trim();
  if (!text || (text.startsWith("#") && !text.startsWith("#HttpOnly_"))) return null;

  const columns = text.includes("\t") ? text.split("\t") : splitNetscapeSpaces(text);
  if (!columns || columns.length < 7) return null;

  const domain = columns[0]?.trim() ?? "";
  const name = columns[5]?.trim() ?? "";
  const value = columns.slice(6).join("\t").trim();
  if (!domain || !name || !value) return null;
  if (domain.startsWith("#") && !domain.startsWith("#HttpOnly_")) return null;

  const flag = columns[1]?.trim() || "TRUE";
  const cookiePath = columns[2]?.trim() || "/";
  const secure = columns[3]?.trim() || "TRUE";
  const expiry = columns[4]?.trim() || "0";
  return {
    domain: domain.replace(/^#HttpOnly_/, ""),
    name,
    value,
    line: [domain, flag, cookiePath, secure, expiry, name, value].join("\t"),
  };
}

function splitNetscapeSpaces(text: string): string[] | null {
  const match = text.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  return match.slice(1, 8);
}

function cookieHint(raw: string): string {
  const text = unescapeCookieText(raw);
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  if (first.startsWith("#") && !first.startsWith("#HttpOnly_")) {
    return `header=${JSON.stringify(first.slice(0, 80))} lines=${text.split(/\r?\n/).length}`;
  }
  return `firstLineLength=${first.length} hasTab=${text.includes("\t")} hasNewline=${text.includes("\n")} lines=${text.split(/\r?\n/).length}`;
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
