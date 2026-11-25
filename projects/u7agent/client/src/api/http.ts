import { hc } from "hono/client";
import type { AppType } from "server";
import type { BackupRestorePlan } from "../types";

export interface ApiErrorDetails {
  /** 変更系の 503 だけが持つ。何も保存されていないことを UI が区別できる */
  state?: "not_stored";
  /** 応答の本文が持つ機械可読なコード（開始拒否の空き不足など）。分類できない失敗は undefined */
  code?: string;
  /** バックアップの復元が 409 で返す再 plan。画面はこれを表示に取り込む */
  plan?: BackupRestorePlan;
}

export class ApiError extends Error {
  public readonly state?: "not_stored";
  /** 応答の本文の `code`。文言ではなくこの値で分岐する（サーバーは固定文言を変えうる） */
  public readonly code?: string;
  /** 復元の 409 が添える再 plan。ダイアログの表示を最新にするために使う */
  public readonly plan?: BackupRestorePlan;

  constructor(
    message: string,
    public readonly status: number,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.state = details.state;
    this.code = details.code;
    this.plan = details.plan;
  }
}

/** 変更系の 503 だけが返す `state: "not_stored"`。何も保存されていないことを UI が区別できる */
export function isNotStoredError(error: unknown): boolean {
  return error instanceof ApiError && error.state === "not_stored";
}

// Vite dev は /api を 4317 へプロキシするため同一オリジンで扱える
export const client = hc<AppType>(location.origin);

async function apiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
  const state =
    typeof body === "object" && body !== null && "state" in body && body.state === "not_stored"
      ? ("not_stored" as const)
      : undefined;
  const code =
    typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
      ? body.code
      : undefined;
  const plan =
    typeof body === "object" && body !== null && "plan" in body && typeof body.plan === "object" && body.plan !== null
      ? (body.plan as BackupRestorePlan)
      : undefined;
  return new ApiError(message, res.status, {
    ...(state === undefined ? {} : { state }),
    ...(code === undefined ? {} : { code }),
    ...(plan === undefined ? {} : { plan }),
  });
}

/**
 * hc の応答は status ごとの ClientResponse の union で、失敗の応答は `ok: false` を持つ。
 * `if (!res.ok) throw` と同じ絞り込みを戻り値の型でも行い、本文の型を成功の応答の側に残す。
 */
type OkResponse<R extends Response> = Exclude<R, { ok: false }>;

/**
 * 失敗の応答を `ApiError` に写して投げる。本文を読まない経路（204 / text / blob）も必ずこれを通す。
 * 応答の型を `Response` に広げると hc の `json()` が `any` になり、server の応答の変更を typecheck が検出できない。
 */
export function ensureOk<R extends Response>(response: Promise<R>): Promise<OkResponse<R>>;
export async function ensureOk(response: Promise<Response>): Promise<Response> {
  const res = await response;
  if (!res.ok) throw await apiError(res);
  return res;
}

/**
 * `ensureOk` の後に本文を JSON として読む。`T` には成功の応答の DTO（正は `types.ts`）を置く。
 * hc の `json()` が成功と失敗の応答の union を返す endpoint だけが使う。union が残らない endpoint は
 * `ensureOk` の戻り値に `res.json()` を直に当て、宣言した戻り値型との照合を残す。
 */
export async function read<T>(response: Promise<Response>): Promise<T> {
  const res = await ensureOk(response);
  return (await res.json()) as T;
}
