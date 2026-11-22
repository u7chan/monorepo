import { resolveVersion } from "./version";

export type CookieSecureMode = "auto" | "always";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  development: boolean;
  version: string;
  /** 前段の TLS 終端を信頼し、X-Forwarded-* を読むか。既定は読まない。 */
  trustProxy: boolean;
  /** auto は要求が HTTPS のとき、always は常に cookie へ Secure を付ける。 */
  cookieSecure: CookieSecureMode;
  /** TLS 終端の後ろでブラウザから見たオリジン。Origin 検査に使う。 */
  appOrigin: string | null;
};

/** コンテナ内で受けるため既定は全インターフェース。ホスト側の公開範囲は compose で絞る。 */
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_DATA_DIR = "/app/data";

export function loadConfig(env: Record<string, string | undefined>, packageVersion: string): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    dataDir: env.DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    development: env.NODE_ENV !== "production",
    version: resolveVersion(env.COMMIT_HASH, packageVersion),
    trustProxy: env.TRUST_PROXY?.trim() === "1",
    cookieSecure: env.COOKIE_SECURE?.trim() === "1" ? "always" : "auto",
    appOrigin: parseAppOrigin(env.APP_ORIGIN),
  };
}

function parsePort(value: string | undefined): number {
  const raw = value?.trim() ?? "";

  if (raw === "") {
    return DEFAULT_PORT;
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT が不正です: ${raw}`);
  }

  return port;
}

function parseAppOrigin(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";

  if (raw === "") {
    return null;
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_ORIGIN が URL ではありません: ${raw}`);
  }

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error(`APP_ORIGIN はパスを持たない http(s) のオリジンにしてください: ${raw}`);
  }

  return url.origin;
}
