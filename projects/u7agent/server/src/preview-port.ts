export const DEFAULT_PREVIEW_PORT = 8080;

export function resolvePreviewPort(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_PREVIEW_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new Error("PI_PREVIEW_PORT は 1〜65535 の整数で指定してください");
  }
  return port;
}
