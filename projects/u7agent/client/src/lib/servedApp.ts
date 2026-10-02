export function servedAppUrl(hostname: string, port: number | undefined): string | undefined {
  if (!hostname || port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${hostname}:${port}/`;
}
