import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "@/lib/command";

export const CLOUD_BLOCK_MESSAGE =
  "클라우드 IP 차단됨: '텍스트 / 자막' 탭을 이용하시거나 쿠키를 설정해주세요";

export async function ensureCookieFile(): Promise<string | null> {
  const pasted = readEnv("YOUTUBE_COOKIES_TEXT");
  if (pasted) return writeCookieFile(pasted);

  const raw = readEnv("YOUTUBE_COOKIES") || readEnv("YTDLP_COOKIES");
  if (!raw) return null;
  if (!raw.includes("\n") && !raw.includes("=") && (await fileExists(raw))) return raw;
  if (!raw.includes("\n") && !raw.includes("\t") && (await fileExists(raw))) return raw;
  return writeCookieFile(raw);
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

  const pairs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    if (columns.length < 7) continue;
    const domain = columns[0] ?? "";
    if (!/youtube\.com|google\.com/i.test(domain)) continue;
    const name = columns[5]?.trim();
    const value = columns.slice(6).join("\t").trim();
    if (!name || !value) continue;
    pairs.push(`${name}=${value}`);
  }

  return pairs.length > 0 ? pairs.join("; ") : null;
}

async function writeCookieFile(raw: string): Promise<string> {
  const file = path.join(process.cwd(), ".data", "bin", "youtube-cookies.txt");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, normalizeCookies(raw), "utf8");
  return file;
}

function normalizeCookies(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    const fromJson = cookiesFromJson(text);
    if (fromJson) return fromJson;
  }
  if (text.includes("# Netscape") || text.includes("\t")) {
    return text.endsWith("\n") ? text : `${text}\n`;
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
      const domain = cookieField(row, ["domain", "Domain"]) || ".youtube.com";
      const cookiePath = cookieField(row, ["path", "Path"]) || "/";
      const secure = row.secure === true || row.Secure === true;
      const expiry = Math.floor(Number(row.expirationDate ?? row.expiry ?? 0)) || 0;
      lines.push(
        `${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${cookiePath}\t${secure ? "TRUE" : "FALSE"}\t${expiry}\t${name}\t${value}`,
      );
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch {
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
