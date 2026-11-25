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

export async function apiError(res: Response): Promise<ApiError> {
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
