import { resolveVersion } from "./version";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  development: boolean;
  version: string;
};

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = "/app/data";

export function loadConfig(env: Record<string, string | undefined>, packageVersion: string): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    dataDir: env.DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    development: env.NODE_ENV !== "production",
    version: resolveVersion(env.COMMIT_HASH, packageVersion),
  };
}

function parsePort(value: string | undefined): number {
  const raw = value?.trim() ?? "";

  if (raw === "") {
    return DEFAULT_PORT;
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT が不正です: ${raw}`);
  }

  return port;
}
