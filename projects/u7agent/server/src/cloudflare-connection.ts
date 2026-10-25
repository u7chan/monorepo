/**
 * 設定 → 共有 → 接続 の「接続を確認」。保存済みの資格情報が Cloudflare へ届くかを、公開の受付が
 * 最初に呼ぶのと同じ subdomain GET 1 本で確かめる。結果は保存せず、失敗も 200 で返す。
 * 契約は docs/static-sharing.md を正とする。
 */
import {
  CloudflareApiError,
  SHARED_CONTENT_NO_SUBDOMAIN,
  type CloudflareAssetsApi,
  type CloudflareFailureKind,
} from "./cloudflare-api";
import {
  SHARED_CONTENT_NO_CREDENTIALS,
  type CloudflareCredential,
  type CloudflareSettingsService,
} from "./cloudflare-settings";
import { httpError } from "./http";
import type { CloudflareConnectionCheckResponse, CloudflareConnectionFailure } from "./schema";

/** `CloudflareFailureKind` を広げずに、空の subdomain だけを接続確認側の失敗として足す */
export type CloudflareConnectionFailureKind = CloudflareFailureKind | "no_subdomain";

/**
 * 接続確認専用の固定文言。公開向けの `CloudflareApiError.message` は 404 が「対象の Worker」、
 * `invalid` が「公開要求」になり、接続の切り分けに使えないため流用しない。
 * キーは schema の `CloudflareConnectionFailure` が正（kind を足したら schema も足す）。
 */
const FAILURE_MESSAGES = {
  unauthorized: "Cloudflare の API トークンが拒否されました。トークンが有効か確認してください",
  not_found: "Cloudflare にアカウントが見つかりません。アカウント ID と workers.dev の設定を確認してください",
  quota: "Cloudflare の Worker の枠が不足しています",
  rate_limited: "Cloudflare の API が混み合っています。時間をおいて再試行してください",
  invalid: "Cloudflare が接続確認の要求を受け付けませんでした。アカウント ID と API トークンの権限を確認してください",
  transient: "Cloudflare の一時的なエラーで確認できませんでした。時間をおいて再試行してください",
  timeout: "Cloudflare への接続がタイムアウトしました",
  network: "Cloudflare へ接続できませんでした",
  unverifiable: "Cloudflare の応答を確認できませんでした",
  no_subdomain: SHARED_CONTENT_NO_SUBDOMAIN,
} satisfies Record<CloudflareConnectionFailure, string>;

/** 403 はアカウント ID の誤りと権限不足の両方があり得るため、401 (トークン拒否) と文言を分ける */
const FORBIDDEN_MESSAGE = "Cloudflare のアカウント ID または Workers Scripts の権限を確認してください";

export interface CloudflareConnectionOptions {
  /** `credential()` の 409 / 503 はそのまま外へ出す (200 の失敗へ写さない) */
  credentials: Pick<CloudflareSettingsService, "credential">;
  /** 公開と同じ factory。確認だけ別の client 設定にしない */
  createCloudflare: (credential: CloudflareCredential) => Pick<CloudflareAssetsApi, "getAccountSubdomain">;
  /** テスト用。省略時は Date.now */
  now?: () => number;
}

export class CloudflareConnectionService {
  #credentials: Pick<CloudflareSettingsService, "credential">;
  #createCloudflare: (credential: CloudflareCredential) => Pick<CloudflareAssetsApi, "getAccountSubdomain">;
  #now: () => number;

  constructor({ credentials, createCloudflare, now }: CloudflareConnectionOptions) {
    this.#credentials = credentials;
    this.#createCloudflare = createCloudflare;
    this.#now = now ?? Date.now;
  }

  async check(): Promise<CloudflareConnectionCheckResponse> {
    // try の外で読む。master key 不在 / 復号不可 (503) を「接続できない」の 200 に化けさせない
    const credential = this.#credentials.credential();
    if (!credential) throw httpError(409, SHARED_CONTENT_NO_CREDENTIALS);
    const checkedAt = this.#now();
    const accountId = credential.accountId;

    let subdomain: string;
    try {
      subdomain = await this.#createCloudflare(credential).getAccountSubdomain();
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      return {
        checkedAt,
        accountId,
        subdomain: null,
        failure: error.kind,
        httpStatus: httpStatusOf(error),
        message: failureMessage(error.kind, error.status),
      };
    }
    if (!subdomain) {
      return {
        checkedAt,
        accountId,
        subdomain: null,
        failure: "no_subdomain",
        httpStatus: null,
        message: FAILURE_MESSAGES.no_subdomain,
      };
    }
    return { checkedAt, accountId, subdomain, failure: null, httpStatus: null, message: null };
  }
}

/** 失敗行に「HTTP 200」を出さない。`unverifiable` は 2xx を持ち得るため 400 以上だけを通す */
function httpStatusOf(error: CloudflareApiError): number | null {
  return error.status !== undefined && error.status >= 400 ? error.status : null;
}

function failureMessage(kind: CloudflareConnectionFailureKind, status: number | undefined): string {
  if (kind === "unauthorized" && status === 403) return FORBIDDEN_MESSAGE;
  return FAILURE_MESSAGES[kind];
}
