export type ServerConfig = {
  host: string;
  port: number;
  development: boolean;
};

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3100;

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    development: env.NODE_ENV !== "production",
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
