export const DEFAULT_PREVIEW_PORT = 8080;

/**
 * サンドボックス内で serve が待ち受けるポート。BFF はここへ TCP connect して稼働を判定する。
 * ブラウザから見た値 (`PI_PREVIEW_PORT`、prod は 8016) とは別物で、`PI_FILE_PREVIEW_LISTEN_PORT` /
 * `PI_FILE_PREVIEW_PORT` と同じく listen 側とブラウザ側を分ける。
 */
export const SERVE_LISTEN_PORT = 8080;

export function resolvePreviewPort(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_PREVIEW_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new Error("PI_PREVIEW_PORT は 1〜65535 の整数で指定してください");
  }
  return port;
}
