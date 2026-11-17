/**
 * 上流の取得。応答本文は保存もログもしないが、壊れた上流でメモリを食い潰さないための上限を置く。
 * 価格の取り込みは手元で実行するので、期限は 1 リクエストごとに独立して掛ける。
 */
export const USER_AGENT = "cost-master-generator/0.1.0";

export const MAX_RESPONSE_BYTES = 1_048_576;
export const REQUEST_TIMEOUT_MS = 15_000;

async function readBody(fetchImpl: typeof fetch, url: URL, accept: string): Promise<string | undefined> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    await discard(response);
    return undefined;
  }

  let text: string;

  try {
    text = await response.text();
  } catch {
    return undefined;
  }

  return text.length > MAX_RESPONSE_BYTES ? undefined : text;
}

export async function readJson(fetchImpl: typeof fetch, url: URL): Promise<unknown | undefined> {
  const text = await readBody(fetchImpl, url, "application/json");

  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** モデルページの markdown alternate（`llms.txt`）。単位の語彙だけを読む */
export async function readText(fetchImpl: typeof fetch, url: URL): Promise<string | undefined> {
  return readBody(fetchImpl, url, "text/markdown, text/plain");
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 失敗の分類には使わない。読み捨てられなくても結果は変わらない
  }
}
