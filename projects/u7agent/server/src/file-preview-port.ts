/**
 * プレビュー オリジン (別リスナー) のポート。待受は BFF と同じプロセス内の定数で、ブラウザから見たポートは
 * env `PI_FILE_PREVIEW_PORT` で差し替える (prod は compose が publish したポートを載せる)。
 * 値は iframe の URL 生成にしか使わず、待受は常に `FILE_PREVIEW_LISTEN_PORT`。
 */
export const FILE_PREVIEW_LISTEN_PORT = 4318;
export const DEFAULT_FILE_PREVIEW_PORT = FILE_PREVIEW_LISTEN_PORT;

/**
 * env の 1 値を解決する。未設定 (空文字を含む) は既定へ倒し、それ以外の不正値は起動時に止める
 * (誤った値は画面に出ず、プレビューが真っ白になるだけなので、起動時に気付けるようにする)。
 */
export function resolveFilePreviewPort(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_FILE_PREVIEW_PORT;
  if (!/^\d+$/.test(text)) throw new Error(`PI_FILE_PREVIEW_PORT は 1〜65535 の整数で指定してください: ${value}`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error(`PI_FILE_PREVIEW_PORT は 1〜65535 の整数で指定してください: ${value}`);
  return port;
}
