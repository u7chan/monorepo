// 状態を変える API の入口チェック。
// portal は LAN 内で認証を持たないため、別サイトのフォームから start/stop/deploy を
// 叩かれないよう、Host と Origin を照合する。

/**
 * 同一 Host からのリクエストか。Origin が無いリクエスト（curl など）は許可する。
 * Origin がある場合は URL の host だけを比較し、TLS 終端の有無による scheme の差は見ない。
 */
export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    return true;
  }

  const host = req.headers.get("host");
  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * JSON の POST か。単純なフォーム送信ではこの Content-Type にならないため、
 * 同一 origin チェックと合わせて CSRF の経路を狭める。
 */
export function isJsonRequest(req: Request): boolean {
  const [type] = (req.headers.get("content-type") ?? "").split(";");
  return type?.trim().toLowerCase() === "application/json";
}
