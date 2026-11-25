/**
 * 設定 → モデルのカスタムプロバイダー「モデル一覧から選ぶ」の probe。
 * `GET {baseUrl}/models` を 1 回だけ叩き、接続できない理由と、選べるモデル ID を返す。
 * 結果は保存せず、失敗も 200 の分類として返す契約 (docs/model-settings.md)。
 */
import { declaredBodyTooLarge, readBodyText } from "./bounded-body";
import { isCustomProviderModelId, normalizeCustomProviderBaseUrl } from "./custom-providers";
import { startRequestDeadline } from "./request-deadline";
import type { CustomProviderProbeFailure, CustomProviderProbeResponse } from "./schema";

/** `/models` の取得期限。モデル一覧は小さく、待たせる理由が無いので鍵同期 (20 秒) とは別に短くする */
export const CUSTOM_PROVIDER_PROBE_TIMEOUT_MS = 5_000;
/** 応答に載せるモデル数の上限。一覧の全件は必要なく、巨大な応答を画面へ流さない */
export const CUSTOM_PROVIDER_PROBE_MODEL_MAX = 200;
/** 応答本文の上限。ID だけを読むため、これを超える本文は形式不明として扱う */
export const CUSTOM_PROVIDER_PROBE_BODY_MAX_BYTES = 256 * 1024;

export const CUSTOM_PROVIDER_PROBE_MESSAGES: Record<CustomProviderProbeFailure, string> = {
  unauthorized: "接続先がAPIキーを拒否しました。キーを確認してください",
  not_found: "モデル一覧が見つかりません。baseUrl に /v1 まで含めているか確認してください",
  http_error: "接続先がエラーを返しました",
  redirected: "接続先がリダイレクトを返しました。baseUrl を直接指定してください",
  invalid_response: "モデル一覧の形式を確認できませんでした。OpenAI 互換の /models を返すか確認してください",
  timeout: "接続がタイムアウトしました",
  unreachable: "接続先へ接続できませんでした",
};

export interface CustomProviderProbeOptions {
  /** テスト用。省略時は globalThis.fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** テスト用。省略時は Date.now */
  now?: () => number;
}

function classified(
  baseUrl: string,
  checkedAt: number,
  failure: CustomProviderProbeFailure,
  httpStatus: number | null = null,
): CustomProviderProbeResponse {
  return {
    checkedAt,
    baseUrl,
    failure,
    httpStatus,
    models: [],
    truncated: false,
    message: CUSTOM_PROVIDER_PROBE_MESSAGES[failure],
  };
}

/** 本文を使わない経路の応答を破棄する。cancel しないと接続がプールに残り、期限後も開いたままになる */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * `data[].id` だけを取り出す。`data` が配列でなければ形式不明 (null)。
 * 要素が object でない / id が string でないものは捨て、登録と同じ境界を通った ID だけを
 * 重複除去して昇順に並べる (選んだ ID が必ず保存検証を通る)。
 */
function modelIdsOf(body: unknown): { ids: string[]; truncated: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !isCustomProviderModelId(id)) continue;
    ids.add(id.trim());
  }
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ids: sorted.slice(0, CUSTOM_PROVIDER_PROBE_MODEL_MAX),
    truncated: sorted.length > CUSTOM_PROVIDER_PROBE_MODEL_MAX,
  };
}

/**
 * 1 回だけ `GET {baseUrl}/models` を叩く。3xx は追わず (転送先へ Authorization を渡さない)、
 * ネットワーク・HTTP・形式の失敗はすべて分類へ寄せる。例外は投げない (baseUrl の形式だけ 400)。
 */
export async function probeCustomProviderModels(
  input: { baseUrl: string; apiKey: string },
  options: CustomProviderProbeOptions = {},
): Promise<CustomProviderProbeResponse> {
  const baseUrl = normalizeCustomProviderBaseUrl(input.baseUrl);
  const checkedAt = (options.now ?? Date.now)();
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = startRequestDeadline(options.timeoutMs ?? CUSTOM_PROVIDER_PROBE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
        redirect: "manual",
        signal: deadline.signal,
      });
    } catch {
      return classified(baseUrl, checkedAt, deadline.timedOut ? "timeout" : "unreachable");
    }
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      return classified(baseUrl, checkedAt, "redirected");
    }
    if (response.status === 401 || response.status === 403) {
      await discardBody(response);
      return classified(baseUrl, checkedAt, "unauthorized", response.status);
    }
    if (response.status === 404) {
      await discardBody(response);
      return classified(baseUrl, checkedAt, "not_found", 404);
    }
    if (!response.ok) {
      await discardBody(response);
      return classified(baseUrl, checkedAt, "http_error", response.status);
    }
    let text: string | undefined;
    try {
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (declaredBodyTooLarge(declared, CUSTOM_PROVIDER_PROBE_BODY_MAX_BYTES)) {
        await discardBody(response);
        return classified(baseUrl, checkedAt, "invalid_response");
      }
      // abort 以外の読み取り失敗でも、ストリームを残して接続を開いたままにしない。
      text = await readBodyText(response.body?.getReader(), CUSTOM_PROVIDER_PROBE_BODY_MAX_BYTES, {
        cancelOnReadError: true,
      });
    } catch {
      return classified(baseUrl, checkedAt, deadline.timedOut ? "timeout" : "invalid_response");
    }
    if (text === undefined) return classified(baseUrl, checkedAt, "invalid_response");
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      return classified(baseUrl, checkedAt, "invalid_response");
    }
    const listed = modelIdsOf(body);
    if (!listed) return classified(baseUrl, checkedAt, "invalid_response");
    return {
      checkedAt,
      baseUrl,
      failure: null,
      httpStatus: null,
      models: listed.ids.map((id) => ({ id })),
      truncated: listed.truncated,
      message: null,
    };
  } finally {
    deadline.clear();
  }
}
