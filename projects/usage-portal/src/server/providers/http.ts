export type JsonResponse = { status: number; json: unknown };

/**
 * 上流の JSON を読むだけの薄い境界。本文も例外文も呼び出し側の外へ出さない前提で、
 * 失敗はすべて `null`（通信失敗）か `json: null`（JSON でない）に畳む。
 */
export async function fetchJson(
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
): Promise<JsonResponse | null> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch {
    return null;
  }

  // エラー応答の本文は読まない。上流が資格情報や proxy の文言を返すことがあり、扱う理由がない。
  if (!response.ok) {
    // 本文を破棄してから戻す。ストリームを開いたままにすると接続が残る。
    await response.body?.cancel().catch(() => undefined);

    return { status: response.status, json: null };
  }

  try {
    const json: unknown = await response.json();

    return { status: response.status, json };
  } catch {
    return { status: response.status, json: null };
  }
}
