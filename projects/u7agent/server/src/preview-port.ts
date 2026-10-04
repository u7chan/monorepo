/**
 * サービス (serve) オリジンのポート。BFF の 3 本目のリスナーが待受 (`PI_SERVICE_LISTEN_PORT`) で受け、
 * `PI_SANDBOX_URL` のホストの 8080 へ転送する。ブラウザから見た値は別の env `PI_PREVIEW_PORT` で、
 * prod は compose が 8016:<待受> を publish して後者に 8016 を載せる。
 */
export const DEFAULT_SERVICE_LISTEN_PORT = 4319;

/** サンドボックス内で serve が待ち受けるポート。BFF はここへ TCP connect して稼働を判定し、HTTP を転送する */
export const SERVE_LISTEN_PORT = 8080;

/** ブラウザから見た値の既定。待受へ寄せて、単体起動でもリンクが繋がるようにする */
export const DEFAULT_PREVIEW_PORT = DEFAULT_SERVICE_LISTEN_PORT;

/**
 * env の 1 値を解決する。未設定 (空文字を含む) は既定へ倒し、それ以外の不正値は起動時に止める
 * (誤った値は画面に出ず、リンクが開けないだけなので、起動時に気付けるようにする)。
 */
function resolvePort(value: string | undefined, envName: string, fallback: number): number {
  const text = value?.trim() ?? "";
  if (text === "") return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`${envName} は 1〜65535 の整数で指定してください: ${value}`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error(`${envName} は 1〜65535 の整数で指定してください: ${value}`);
  return port;
}

/**
 * 3 本目のリスナー (サービス オリジン) の待受ポート。dev ではアプリ自身が 8080 を使うため、
 * 既定を 8080 にしない。prod は publish が 8016:4319 なので既定のまま。
 */
export function resolveServiceListenPort(value: string | undefined): number {
  return resolvePort(value, "PI_SERVICE_LISTEN_PORT", DEFAULT_SERVICE_LISTEN_PORT);
}

/** ブラウザから見たポート。未設定は待受へ寄せる (prod は compose が 8016 を明示) */
export function resolvePreviewPort(value: string | undefined, listenPort: number = DEFAULT_PREVIEW_PORT): number {
  return resolvePort(value, "PI_PREVIEW_PORT", listenPort);
}
