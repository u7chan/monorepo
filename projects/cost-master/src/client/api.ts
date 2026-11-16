import type { CostMasterPayload, MasterKind } from "../shared/contract";

export async function fetchModels(signal: AbortSignal): Promise<CostMasterPayload> {
  const response = await fetch("/api/models", { signal, headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`マスタを取得できませんでした (HTTP ${response.status})`);
  }

  return (await response.json()) as CostMasterPayload;
}

export type UploadResult = { ok: true; version: number | null } | { ok: false; message: string };

/** 画面から選んだファイルをそのまま PUT する。検証はサーバーが行い、失敗時は反映しない */
export async function uploadMaster(kind: MasterKind, text: string): Promise<UploadResult> {
  let response: Response;

  try {
    response = await fetch(`/api/master/${kind}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
  } catch {
    return { ok: false, message: "アップロードできませんでした（接続を確認してください）" };
  }

  if (!response.ok) {
    const reason = await readReason(response);

    return { ok: false, message: uploadErrorMessage(response.status, reason) };
  }

  const body = (await response.json()) as { version?: number | null };

  return { ok: true, version: body.version ?? null };
}

export function masterDownloadUrl(kind: MasterKind): string {
  return `/api/master/${kind}`;
}

async function readReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { reason?: unknown };

    return typeof body.reason === "string" ? body.reason : "";
  } catch {
    return "";
  }
}

/** 失敗の理由は固定文言に寄せる。上流本文やサーバーの内部値をそのまま出さない */
export function uploadErrorMessage(status: number, reason: string): string {
  if (status === 413) {
    return "ファイルが大きすぎます（1 MiB まで）";
  }

  if (status === 403) {
    return "この画面以外からの操作は受け付けません";
  }

  if (status !== 400) {
    return `反映できませんでした (HTTP ${status})`;
  }

  switch (reason) {
    case "json":
      return "JSON として読めません。反映していません";
    case "rows":
      return "内容に不正な行があります。1 行でも不正なら反映しません";
    case "master":
      return "置き換えるとマスタを読めなくなるため、反映していません";
    default:
      return "ファイルの形が違います。反映していません";
  }
}
