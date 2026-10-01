/**
 * プレビュー オリジン (別リスナー) のポート。待受は env `PI_FILE_PREVIEW_LISTEN_PORT`、ブラウザから見た値は
 * 別の env `PI_FILE_PREVIEW_PORT` で差し替える (prod は compose が 8017:4318 を publish して後者に 8017 を載せる)。
 */
export const DEFAULT_FILE_PREVIEW_LISTEN_PORT = 4318;
export const DEFAULT_FILE_PREVIEW_PORT = DEFAULT_FILE_PREVIEW_LISTEN_PORT;

/**
 * env の 1 値を解決する。未設定 (空文字を含む) は既定へ倒し、それ以外の不正値は起動時に止める
 * (誤った値は画面に出ず、プレビューが真っ白になるだけなので、起動時に気付けるようにする)。
 */
function resolvePort(value: string | undefined, envName: string): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_FILE_PREVIEW_PORT;
  if (!/^\d+$/.test(text)) throw new Error(`${envName} は 1〜65535 の整数で指定してください: ${value}`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error(`${envName} は 1〜65535 の整数で指定してください: ${value}`);
  return port;
}

/** ブラウザから見たポート。待受とは独立で、prod は publish したポートを載せる */
export function resolveFilePreviewPort(value: string | undefined): number {
  return resolvePort(value, "PI_FILE_PREVIEW_PORT");
}

/** 2 本目のリスナーの待受ポート。prod は publish が 8017:4318 なので既定のまま */
export function resolveFilePreviewListenPort(value: string | undefined): number {
  return resolvePort(value, "PI_FILE_PREVIEW_LISTEN_PORT");
}

/**
 * `pnpm dev` (scripts/dev.mjs) 用。dev はブラウザがプレビュー オリジンを直接開くため、待受とブラウザから見た
 * 値が同じでなければならない。`PI_FILE_PREVIEW_PORT` を正とし、待受 env しか無いときはその値へ寄せる。
 */
export function resolveDevFilePreviewPort(env: {
  PI_FILE_PREVIEW_PORT?: string;
  PI_FILE_PREVIEW_LISTEN_PORT?: string;
}): number {
  if ((env.PI_FILE_PREVIEW_PORT ?? "").trim() !== "") return resolveFilePreviewPort(env.PI_FILE_PREVIEW_PORT);
  if ((env.PI_FILE_PREVIEW_LISTEN_PORT ?? "").trim() !== "") {
    return resolveFilePreviewListenPort(env.PI_FILE_PREVIEW_LISTEN_PORT);
  }
  return DEFAULT_FILE_PREVIEW_PORT;
}
