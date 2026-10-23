/**
 * Cloudflare Workers の静的アセット direct upload。API トークンと応答本文は外へ出さず、
 * 失敗は分類済みの `CloudflareApiError` に閉じる。契約は docs/static-sharing.md を正とする。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Cloudflare の 1 リクエスト上限 (Free 100 MB) に対し、base64 と multipart の余白を残す */
const MAX_UPLOAD_RAW_BYTES = 64 * 1024 * 1024;

export type CloudflareFailureKind =
  | "unauthorized"
  | "not_found"
  | "quota"
  | "rate_limited"
  | "invalid"
  | "transient"
  | "timeout"
  | "network";

const FAILURE_MESSAGES: Record<CloudflareFailureKind, string> = {
  unauthorized: "Cloudflare の認証に失敗しました。API トークンの権限を確認してください",
  not_found: "Cloudflare に対象の Worker が見つかりません",
  quota: "Cloudflare の Worker の枠が不足しています",
  rate_limited: "Cloudflare の API が混み合っています。時間をおいて再試行してください",
  invalid: "Cloudflare が公開要求を受け付けませんでした",
  transient: "Cloudflare の一時的なエラーで公開できませんでした",
  timeout: "Cloudflare への接続がタイムアウトしました",
  network: "Cloudflare へ接続できませんでした",
};

/** 分類だけを公開する。応答本文・トークン・URL は message へ入れない */
export class CloudflareApiError extends Error {
  constructor(
    readonly kind: CloudflareFailureKind,
    readonly status: number | undefined = undefined,
    readonly code: number | undefined = undefined,
  ) {
    super(FAILURE_MESSAGES[kind]);
    this.name = "CloudflareApiError";
  }
}

export interface CloudflareAsset {
  /** 共有物の root からの相対パス (例 `index.html`) */
  path: string;
  /** 配信時の Content-Type */
  contentType: string;
  /** 展開済みファイルの実パス。アップロード時に読む */
  file: string;
  size: number;
  /** manifest のキー。32 桁の 16 進数 */
  hash: string;
}

export interface CloudflareScriptSubdomain {
  enabled: boolean;
  previewsEnabled: boolean;
}

/** ルートの `_headers` / `_redirects` はアセットではなく config として送る */
export interface CloudflareAssetConfig {
  headers?: string;
  redirects?: string;
}

export interface CloudflareAssetsApi {
  getAccountSubdomain(): Promise<string>;
  getScriptSubdomain(scriptName: string): Promise<CloudflareScriptSubdomain>;
  /** manifest 登録 → アセット送信 → deployment → workers.dev 有効化 */
  publishAssets(scriptName: string, assets: readonly CloudflareAsset[], config?: CloudflareAssetConfig): Promise<void>;
}

export interface CloudflareApiClientOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** manifest / deployment / subdomain のタイムアウト */
  timeoutMs?: number;
  /** アセット送信のタイムアウト */
  uploadTimeoutMs?: number;
  baseUrl?: string;
  now?: () => number;
  readFileImpl?: (path: string) => Promise<Buffer>;
}

/** 32 桁 16 進の manifest ハッシュ。内容と MIME の組で一意にする */
export function cloudflareAssetHash(content: Buffer, contentType: string): string {
  return createHash("sha256").update(content).update("\0").update(contentType).digest("hex").slice(0, 32);
}

export class CloudflareApiClient implements CloudflareAssetsApi {
  #accountId: string;
  #apiToken: string;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #uploadTimeoutMs: number;
  #baseUrl: string;
  #now: () => number;
  #readFile: (path: string) => Promise<Buffer>;

  constructor(options: CloudflareApiClientOptions) {
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#now = options.now ?? Date.now;
    this.#readFile = options.readFileImpl ?? ((path) => readFile(path));
  }

  async getAccountSubdomain(): Promise<string> {
    const result = await this.#request(this.#accountPath("/workers/subdomain"));
    if (!isRecord(result) || typeof result.subdomain !== "string") throw new CloudflareApiError("invalid");
    return result.subdomain.trim();
  }

  async getScriptSubdomain(scriptName: string): Promise<CloudflareScriptSubdomain> {
    const result = await this.#request(this.#scriptPath(scriptName, "/subdomain"));
    if (!isRecord(result) || typeof result.enabled !== "boolean") throw new CloudflareApiError("invalid");
    return { enabled: result.enabled, previewsEnabled: result.previews_enabled === true };
  }

  async publishAssets(
    scriptName: string,
    assets: readonly CloudflareAsset[],
    config?: CloudflareAssetConfig,
  ): Promise<void> {
    if (assets.length === 0) throw new CloudflareApiError("invalid");
    const manifest = Object.fromEntries(
      assets.map((asset) => [`/${asset.path}`, { hash: asset.hash, size: asset.size }]),
    );
    const session = await this.#request(this.#scriptPath(scriptName, "/assets-upload-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    const uploadJwt = isRecord(session) && typeof session.jwt === "string" ? session.jwt : "";
    const buckets = isRecord(session) && Array.isArray(session.buckets) ? session.buckets : undefined;
    if (!uploadJwt || !buckets || !buckets.every((bucket) => Array.isArray(bucket))) {
      throw new CloudflareApiError("invalid");
    }

    const byHash = new Map(assets.map((asset) => [asset.hash, asset]));
    let completionJwt = buckets.length === 0 ? uploadJwt : "";
    for (const chunk of splitBuckets(buckets as string[][], byHash)) {
      let rawBytes = 0;
      const form = new FormData();
      for (const hash of chunk) {
        const asset = byHash.get(hash);
        if (!asset) throw new CloudflareApiError("invalid");
        const content = await this.#readFile(asset.file);
        rawBytes += content.length;
        // 1 リクエストの上限を越えないよう、分割後の実サイズをここでも確認する
        if (rawBytes > MAX_UPLOAD_RAW_BYTES) throw new CloudflareApiError("invalid");
        form.append(hash, new Blob([content.toString("base64")], { type: asset.contentType }), hash);
      }
      const uploaded = await this.#request(
        this.#accountPath("/workers/assets/upload?base64=true"),
        { method: "POST", body: form },
        this.#uploadTimeoutMs,
        uploadJwt,
      );
      if (isRecord(uploaded) && typeof uploaded.jwt === "string") completionJwt = uploaded.jwt;
    }
    if (!completionJwt) throw new CloudflareApiError("invalid");

    const metadata = {
      // 静的アセットだけの Worker。main_module / bindings は置かない
      assets: {
        jwt: completionJwt,
        config: {
          html_handling: "auto-trailing-slash",
          not_found_handling: "single-page-application",
          ...(config?.headers !== undefined ? { _headers: config.headers } : {}),
          ...(config?.redirects !== undefined ? { _redirects: config.redirects } : {}),
        },
      },
      compatibility_date: new Date(this.#now()).toISOString().slice(0, 10),
    };
    const deployForm = new FormData();
    deployForm.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    await this.#request(this.#scriptPath(scriptName, ""), { method: "PUT", body: deployForm }, this.#uploadTimeoutMs);

    await this.#request(this.#scriptPath(scriptName, "/subdomain"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
  }

  #accountPath(suffix: string): string {
    return `/accounts/${encodeURIComponent(this.#accountId)}${suffix}`;
  }

  #scriptPath(scriptName: string, suffix: string): string {
    return `${this.#accountPath("/workers/scripts")}/${encodeURIComponent(scriptName)}${suffix}`;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.#timeoutMs,
    token = this.#apiToken,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new CloudflareApiError("timeout");
      throw new CloudflareApiError("network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // ヘッダ受信後の切断・期限切れも、公開結果が不明な失敗として扱う
      const name = error instanceof Error ? error.name : "";
      throw new CloudflareApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // HTTP 200 でも本文が壊れていれば成功にしない。result の有無も endpoint 側で必ず確かめる
    if (!response.ok || !isRecord(body) || body.success !== true || !("result" in body)) {
      throw classifyFailure(response.status, body);
    }
    return body.result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function classifyFailure(status: number, body: unknown): CloudflareApiError {
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const messages = errors
    .map((entry) => (isRecord(entry) && typeof entry.message === "string" ? entry.message : ""))
    .join(" ");
  const code = errors
    .map((entry) => (isRecord(entry) && typeof entry.code === "number" ? entry.code : undefined))
    .find((value): value is number => value !== undefined);
  // 429 / 5xx を「枠不足」へ誤分類しない。quota は 400 / 403 の本文だけで判定する
  if (status === 429) return new CloudflareApiError("rate_limited", status, code);
  if (status >= 500) return new CloudflareApiError("transient", status, code);
  if ((status === 400 || status === 403) && /quota|limit|too many|maximum/i.test(messages)) {
    return new CloudflareApiError("quota", status, code);
  }
  if (status === 401 || status === 403) return new CloudflareApiError("unauthorized", status, code);
  if (status === 404) return new CloudflareApiError("not_found", status, code);
  return new CloudflareApiError("invalid", status, code);
}

/** Cloudflare の bucket を 1 リクエストの実サイズ上限でさらに分ける */
function splitBuckets(buckets: readonly string[][], byHash: ReadonlyMap<string, CloudflareAsset>): string[][] {
  const chunks: string[][] = [];
  for (const bucket of buckets) {
    let chunk: string[] = [];
    let bytes = 0;
    for (const hash of bucket) {
      const size = byHash.get(hash)?.size ?? 0;
      if (chunk.length > 0 && bytes + size > MAX_UPLOAD_RAW_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(hash);
      bytes += size;
    }
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}
