import { resolveVersion } from "./version";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  credentialDir: string;
  opencodeApiKey: string | null;
  pollIntervalMs: number;
  development: boolean;
  version: string;
};

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = "/app/data";
const DEFAULT_CREDENTIAL_DIR = "/app/credentials";
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** 上流のレート制限を自分で踏まないための下限。 */
const MIN_POLL_INTERVAL_MS = 60 * 1000;

export function loadConfig(env: Record<string, string | undefined>, packageVersion: string): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    dataDir: env.DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    credentialDir: env.CREDENTIAL_DIR?.trim() || DEFAULT_CREDENTIAL_DIR,
    opencodeApiKey: env.OPENCODE_API_KEY?.trim() || null,
    pollIntervalMs: parsePollInterval(env.POLL_INTERVAL_MS),
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

function parsePollInterval(value: string | undefined): number {
  const raw = value?.trim() ?? "";

  if (raw === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const interval = Number(raw);

  if (!Number.isInteger(interval) || interval < MIN_POLL_INTERVAL_MS) {
    throw new Error(`POLL_INTERVAL_MS が不正です: ${raw}`);
  }

  return interval;
}
