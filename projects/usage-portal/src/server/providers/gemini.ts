import { ON_DEMAND_REFRESH_INTERVAL_MS } from "../../shared/on-demand";
import { GeminiCliError, type GeminiCli, type GeminiCliResult } from "../gemini/cli";
import {
  ProviderError,
  WINDOW_LABELS,
  readNumber,
  readPercent,
  readString,
  type ProviderSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./types";

export const GEMINI_NAME = "Gemini";
/** 取得からこの時間を過ぎたら stale。画面を開いたときの自動取得もこの間隔を空ける。 */
export const GEMINI_REFRESH_INTERVAL_MS = ON_DEMAND_REFRESH_INTERVAL_MS;

/** 接続の判定に使う。ログイン済みは exit 0、未ログインは exit 1 と下のサインイン文言を stderr に出す。 */
export const GEMINI_MODELS_ARGS: readonly string[] = ["models"];
/** `/usage` はモデルを呼ばず、会話も残さない。未ログインでは OAuth 待ちで止まるため、接続の確認を先に済ませる。 */
export const GEMINI_USAGE_ARGS: readonly string[] = ["-p", "/usage", "--output-format", "json"];

/** CLI の既定の文言。ネットワークの失敗と区別するため、これを含む exit 1 だけを未接続とする。 */
const SIGN_IN_MESSAGE = "Please sign in to view available models.";

/** Gemini Models グループの bucket id の接頭辞。`3p-*`（Claude / GPT）は読まない。 */
const GEMINI_BUCKET_PREFIX = "gemini-";

/** 上流の `window` を、このアプリの窓へ振る。窓の id は sample の主キーに入るため変えない。 */
const WINDOWS: readonly { upstream: string; id: WindowKind; durationSeconds: number }[] = [
  { upstream: "5h", id: "rolling", durationSeconds: 18_000 },
  { upstream: "weekly", id: "weekly", durationSeconds: 604_800 },
];

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type GeminiConnection = "connected" | "not_connected";

type Candidate = { id: WindowKind; rawUsedPercent: number; resetsAt: number | null };

/**
 * `/usage` の `command.data.groups[].buckets[]` から、Gemini Models の窓だけを作る。
 * 窓の種類ごとに 1 本へ畳み、1 つも読めなければ schema エラー。
 * bucket の `name` / `description`（上流の自由文）は読まず、固定のラベルだけを使う。
 */
export function parseGeminiUsage(body: unknown, capturedAt: number): ProviderSnapshot {
  const best = new Map<WindowKind, Candidate>();

  for (const bucket of readBuckets(body)) {
    const candidate = readCandidate(bucket);

    if (candidate === null) {
      continue;
    }

    const current = best.get(candidate.id);

    // 同じ窓に複数あるときは、使用率の高い bucket を採る。リセット時刻もその bucket のもの。
    if (current === undefined || candidate.rawUsedPercent > current.rawUsedPercent) {
      best.set(candidate.id, candidate);
    }
  }

  const windows: UsageWindow[] = [];
  let overflow = false;

  for (const definition of WINDOWS) {
    const candidate = best.get(definition.id);

    if (candidate === undefined) {
      continue;
    }

    const percent = readPercent(candidate.rawUsedPercent);

    if (percent === null) {
      continue;
    }

    windows.push({
      id: definition.id,
      label: WINDOW_LABELS[definition.id],
      durationSeconds: definition.durationSeconds,
      usedPercent: percent.usedPercent,
      resetsAt: candidate.resetsAt,
    });

    overflow ||= percent.overflow;
  }

  if (windows.length === 0) {
    throw new ProviderError("schema", "Gemini の出力を解釈できませんでした");
  }

  return {
    provider: "gemini",
    name: GEMINI_NAME,
    // 個人向けの plan は CLI から取れない。カードの固定文言でも plan 名は断定しない。
    plan: null,
    capturedAt,
    limitReached: windows.some((window) => window.usedPercent >= 100),
    windows,
    notes: overflow ? ["上限超過"] : [],
  };
}

/**
 * `agy models` で接続を確かめる。exit 0 は接続済み、exit 1 でサインインの文言があれば未接続。
 * それ以外（期限超過・別の終了コード）は上流の失敗で、未接続とは決めない。stderr は判定にだけ使い、外へ出さない。
 */
export async function readGeminiConnection(cli: GeminiCli): Promise<GeminiConnection> {
  const result = await runCli(cli, GEMINI_MODELS_ARGS);

  if (result.exitCode === 0) {
    return "connected";
  }

  if (result.exitCode === 1 && result.stderr.includes(SIGN_IN_MESSAGE)) {
    return "not_connected";
  }

  throw new ProviderError("upstream", "Gemini の CLI から接続状態を取得できませんでした");
}

/**
 * 公式 CLI を 2 回呼ぶ。接続を確かめてから `/usage` を起動し、未接続なら `/usage` は呼ばない。
 */
export async function fetchGeminiUsage(options: { cli: GeminiCli; now: () => number }): Promise<ProviderSnapshot> {
  if ((await readGeminiConnection(options.cli)) === "not_connected") {
    throw new ProviderError("not_connected", "Gemini にサインインしていません");
  }

  const result = await runCli(options.cli, GEMINI_USAGE_ARGS);

  if (result.exitCode !== 0) {
    throw new ProviderError("upstream", "Gemini の CLI から利用枠を取得できませんでした");
  }

  let body: unknown;

  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new ProviderError("schema", "Gemini の出力を解釈できませんでした");
  }

  return parseGeminiUsage(body, options.now());
}

async function runCli(cli: GeminiCli, args: readonly string[]): Promise<GeminiCliResult> {
  try {
    return await cli.run(args);
  } catch (error) {
    if (error instanceof GeminiCliError && error.reason === "spawn") {
      throw new ProviderError("config", "Gemini の CLI を実行できませんでした");
    }

    // 例外文にはパスや環境が混ざり得る。分類だけを残し、文言は固定へ寄せる。
    throw new ProviderError("upstream", "Gemini から利用枠を取得できませんでした");
  }
}

function readBuckets(body: unknown): unknown[] {
  const data = readChild(readChild(body, "command"), "data");

  return readArray(data, "groups").flatMap((group) => readArray(group, "buckets"));
}

function readCandidate(bucket: unknown): Candidate | null {
  const id = readString(bucket, "id");

  if (id === null || !id.startsWith(GEMINI_BUCKET_PREFIX)) {
    return null;
  }

  const definition = WINDOWS.find((window) => window.upstream === readString(bucket, "window"));
  const remaining = readNumber(bucket, "remaining_fraction");

  // 未知の窓と、残りの無い bucket は 0% や 100% に見立てず捨てる。
  if (definition === undefined || remaining === null) {
    return null;
  }

  return {
    id: definition.id,
    rawUsedPercent: (1 - remaining) * 100,
    resetsAt: readResetTime(bucket),
  };
}

/** ISO 8601 だけを読む。1970-01-01 の bucket は捨てない。捨てると、未使用の 5 時間窓まで画面から消える。 */
function readResetTime(bucket: unknown): number | null {
  const value = readString(bucket, "reset_time");

  if (value === null || !ISO_8601.test(value)) {
    return null;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) && time > 0 ? time : null;
}

function readChild(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  const child = readChild(value, key);

  return Array.isArray(child) ? child : [];
}
