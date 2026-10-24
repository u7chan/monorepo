/**
 * 静的成果物の共有。sandbox の ZIP を全量取得して検証し、Cloudflare の静的アセットとして公開する。
 * 資格情報は BFF だけが扱い、状態は `shared_contents` へ記録する。契約は docs/static-sharing.md を正とする。
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CloudflareCredential, CloudflareSettingsService } from "./cloudflare-settings";
import {
  CloudflareApiError,
  cloudflareAssetHash,
  type CloudflareAsset,
  type CloudflareAssetsApi,
} from "./cloudflare-api";
import type { SharedContentRow, SharedContentStatus } from "./app-db";
import { httpError, messageFor } from "./http";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { extractZipEntry, readZipArchive, type ZipReadEntry } from "./sandbox/zip-read";
import type {
  CreateSharedContentBody,
  SharedContentMutationResponse,
  SharedContentResponse,
  SharedContentStopResponse,
} from "./schema";

/** Cloudflare の上限と u7agent の ZIP 上限の厳しいほう */
export const SHARED_CONTENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SHARED_CONTENT_MAX_ENTRIES = 10_000;
export const SHARED_CONTENT_MAX_BYTES = 100 * 1024 * 1024;
export const SHARED_CONTENT_MAX_PATH_LENGTH = 1024;
export const SHARED_CONTENT_MAX_NAME_LENGTH = 100;

const PROVIDER = "cloudflare";
const SCRIPT_PREFIX = "u7s-";

export const SHARED_CONTENT_NO_CREDENTIALS = "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください";
export const SHARED_CONTENT_ACCOUNT_MISMATCH =
  "公開先の Cloudflare アカウントが現在の接続と一致しません。設定 → 共有 → 接続 を確認してください";
export const SHARED_CONTENT_SESSION_REQUIRED = "セッションが削除されているため、この共有物は更新できません";
export const SHARED_CONTENT_SOURCE_REQUIRED = "公開するディレクトリが見つかりません";
export const SHARED_CONTENT_SANDBOX_UNAVAILABLE = "サンドボックスが利用できないため公開できません";
export const SHARED_CONTENT_NO_SUBDOMAIN =
  "Cloudflare アカウントの workers.dev サブドメインが未設定です。Cloudflare のダッシュボードで有効にしてください";
export const SHARED_CONTENT_BUSY = "公開処理中です。完了してから操作してください";
export const SHARED_CONTENT_NOT_UPDATABLE = "この状態からは公開できません";
export const SHARED_CONTENT_NOT_STOPPABLE = "この状態からは停止できません";
export const SHARED_CONTENT_NOT_RESUMABLE = "停止中の共有物だけを再公開できます";
export const SHARED_CONTENT_DELETE_ERROR = "Cloudflare の公開物を削除できませんでした。時間をおいて再試行してください";
export const SHARED_CONTENT_RECONCILE_FAILED = "公開の結果を確認できませんでした。Cloudflare の状態を確認してください";
export const SHARED_CONTENT_STORE_ERROR = "共有コンテンツを保存できませんでした";
export const SHARED_CONTENT_READ_ERROR = "共有コンテンツを読み取れません";

/** ソースの検証・取得で止まったことを表す。message は利用者向けの固定文言だけ */
class SharedContentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedContentSourceError";
  }
}

/**
 * 共有物 id 単位の排他。全共有物を 1 本のロックで直列化しない。
 * 待たせずに断るのは、二重操作を 409 で返す契約だから (待つと応答が provider の所要時間に引きずられる)。
 */
class SharedContentLock {
  #busy = new Set<string>();

  /** 同じ id の操作が進行中なら null。進行中でなければ占有して実行する */
  tryRun<T>(id: string, task: () => Promise<T>): Promise<T> | null {
    if (this.#busy.has(id)) return null;
    this.#busy.add(id);
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.#busy.delete(id);
      });
  }
}

export interface SharedContentStore {
  insertSharedContent(row: SharedContentRow): void;
  updateSharedContentState(
    id: string,
    patch: {
      status: SharedContentStatus;
      updatedAt: number;
      publishedAt: number | null;
      stoppedAt: number | null;
      lastError: string | null;
    },
  ): void;
  getSharedContent(id: string): SharedContentRow | undefined;
  /** `sessionId` を渡すと、その会話で作った共有物だけを返す (GUI の「この会話の共有物」) */
  listSharedContents(sessionId?: string): SharedContentRow[];
  listPublishingSharedContents(): SharedContentRow[];
  /** provider 側の削除が成功したあとにだけ呼ぶ */
  deleteSharedContent(id: string): void;
}

export interface SharedContentsOptions {
  store: SharedContentStore;
  sessions: { workdirOfId(id: string): string | undefined };
  workspace: SandboxWorkspaceClient | null;
  credentials: Pick<CloudflareSettingsService, "credential">;
  createCloudflare: (credential: CloudflareCredential) => CloudflareAssetsApi;
  rootCwd: string;
  /** ログのマスク。応答 / lastError へは生の値を入れない */
  maskError: (text: string) => string;
  /** retainSecret が保持する既知の秘密値。成果物との完全一致検査に使う */
  secretValues: () => readonly string[];
  now?: () => number;
  newId?: () => string;
  tempRoot?: string;
}

/** sandbox の ZIP を全量取得し、検証・展開して Cloudflare へ送る資産一覧を作る */
export class SharedContentsService {
  #store: SharedContentStore;
  #sessions: { workdirOfId(id: string): string | undefined };
  #workspace: SandboxWorkspaceClient | null;
  #credentials: Pick<CloudflareSettingsService, "credential">;
  #createCloudflare: (credential: CloudflareCredential) => CloudflareAssetsApi;
  #rootCwd: string;
  #maskError: (text: string) => string;
  #secretValues: () => readonly string[];
  #now: () => number;
  #newId: () => string;
  #tempRoot: string;
  /** 共有物 id 単位の排他。公開ジョブ自体はこのロックの外で走る */
  #lock = new SharedContentLock();
  #active = new Set<string>();

  constructor(options: SharedContentsOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#workspace = options.workspace;
    this.#credentials = options.credentials;
    this.#createCloudflare = options.createCloudflare;
    this.#rootCwd = options.rootCwd;
    this.#maskError = options.maskError;
    this.#secretValues = options.secretValues;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomBytes(5).toString("hex"));
    this.#tempRoot = options.tempRoot ?? tmpdir();
  }

  list(sessionId?: string): SharedContentResponse[] {
    try {
      return this.#store.listSharedContents(sessionId).map(toResponse);
    } catch {
      throw httpError(503, SHARED_CONTENT_READ_ERROR);
    }
  }

  get(id: string): SharedContentResponse {
    let row: SharedContentRow | undefined;
    try {
      row = this.#store.getSharedContent(id);
    } catch {
      throw httpError(503, SHARED_CONTENT_READ_ERROR);
    }
    if (!row) throw httpError(404, "Shared content not found");
    return toResponse(row);
  }

  /** 作成して公開を開始する。URL は受付時に確定し、ジョブの成否で変えない */
  async create(input: CreateSharedContentBody): Promise<SharedContentMutationResponse> {
    const credential = this.#requireCredentials();
    const sessionCwd = this.#sessions.workdirOfId(input.sessionId);
    if (!sessionCwd) throw httpError(404, "Session not found");
    const sourcePath = resolveSharedContentSource(this.#rootCwd, sessionCwd, input.directory);
    const name = normalizeSharedContentName(input.name, sourcePath);
    await this.#requireSource(sourcePath);

    const client = this.#createCloudflare(credential);
    let subdomain: string;
    try {
      subdomain = await client.getAccountSubdomain();
    } catch (error) {
      throw httpError(502, cloudflareFailureMessage(error));
    }
    if (!subdomain) throw httpError(409, SHARED_CONTENT_NO_SUBDOMAIN);

    const id = this.#newId();
    const remoteId = `${SCRIPT_PREFIX}${id}`;
    const now = this.#now();
    const row: SharedContentRow = {
      id,
      sessionId: input.sessionId,
      name,
      sourcePath,
      provider: PROVIDER,
      providerAccount: credential.accountId,
      remoteId,
      publicUrl: `https://${remoteId}.${subdomain}.workers.dev/`,
      status: "publishing",
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      stoppedAt: null,
      lastError: null,
    };
    try {
      this.#store.insertSharedContent(row);
    } catch {
      throw httpError(503, SHARED_CONTENT_STORE_ERROR);
    }
    this.#start(row, null);
    return { id, status: "publishing" };
  }

  /** 更新 / 未公開からの再試行。ソースとセッションが揃っているときだけ受け付ける */
  async publish(id: string): Promise<SharedContentMutationResponse> {
    return this.#mutate(id, async () => {
      const row = this.#requireRow(id);
      if (row.status === "publishing") throw httpError(409, SHARED_CONTENT_BUSY);
      if (row.status !== "published" && row.status !== "failed") {
        throw httpError(409, SHARED_CONTENT_NOT_UPDATABLE);
      }
      const sessionCwd = this.#sessions.workdirOfId(row.sessionId);
      if (!sessionCwd) throw httpError(409, SHARED_CONTENT_SESSION_REQUIRED);
      this.#assertSourceUnderSession(row.sourcePath, sessionCwd);
      await this.#requireSource(row.sourcePath);
      this.#requireRowCredential(row);

      this.#persistState(row, "publishing", null, { publishedAt: row.publishedAt, stoppedAt: row.stoppedAt });
      this.#start(row, row.status);
      return { id, status: "publishing" as const };
    });
  }

  /**
   * 停止。workers.dev の subdomain を無効にするだけで、URL と行は残す。
   * provider の呼び出しを伴うが、結果を status で返す契約なので同期で確定させる (200)。
   */
  async stop(id: string): Promise<SharedContentStopResponse> {
    return this.#mutate(id, async () => {
      const row = this.#requireRow(id);
      const startStatus = row.status;
      if (startStatus === "publishing" && row.lastError === null) throw httpError(409, SHARED_CONTENT_BUSY);
      // 結果不明で publishing のまま残った行は、停止が冪等なので安全側に倒せる
      if (startStatus !== "published" && startStatus !== "publishing") {
        throw httpError(409, SHARED_CONTENT_NOT_STOPPABLE);
      }
      if (!row.remoteId) throw httpError(409, SHARED_CONTENT_NOT_STOPPABLE);
      const client = this.#createCloudflare(this.#requireRowCredential(row));
      try {
        await client.setScriptSubdomain(row.remoteId, false);
      } catch (error) {
        return await this.#settleStopFailure(row, startStatus, error);
      }
      this.#persistState(row, "stopped", null, { publishedAt: row.publishedAt, stoppedAt: this.#now() });
      return { id, status: "stopped" as const };
    });
  }

  /** 再公開。停止中だった公開物の subdomain を有効に戻すだけで、成果物は送らない */
  async resume(id: string): Promise<SharedContentMutationResponse> {
    return this.#mutate(id, async () => {
      const row = this.#requireRow(id);
      if (row.status !== "stopped") throw httpError(409, SHARED_CONTENT_NOT_RESUMABLE);
      if (!row.remoteId) throw httpError(409, SHARED_CONTENT_NOT_RESUMABLE);
      this.#requireRowCredential(row);
      this.#persistState(row, "publishing", null, { publishedAt: row.publishedAt, stoppedAt: row.stoppedAt });
      this.#startResume(row);
      return { id, status: "publishing" as const };
    });
  }

  /**
   * 削除。provider 側の削除が成功してから行を消す。
   * provider が「既に無い」(404) を返したときも、外部に公開物が無いので成功として扱う。
   */
  async remove(id: string): Promise<void> {
    await this.#mutate(id, async () => {
      const row = this.#requireRow(id);
      // 公開ジョブと provider の操作が重なると、消したはずの script が後から作り直される
      if (row.status === "publishing" && row.lastError === null) throw httpError(409, SHARED_CONTENT_BUSY);
      if (row.remoteId && row.providerAccount) {
        const client = this.#createCloudflare(this.#requireRowCredential(row));
        try {
          await client.deleteScript(row.remoteId);
        } catch (error) {
          if (!(error instanceof CloudflareApiError && error.kind === "not_found")) {
            throw httpError(502, error instanceof CloudflareApiError ? error.message : SHARED_CONTENT_DELETE_ERROR);
          }
        }
      }
      try {
        this.#store.deleteSharedContent(id);
      } catch {
        throw httpError(503, SHARED_CONTENT_STORE_ERROR);
      }
    });
  }

  /** 同じ id の操作を排他する。進行中なら状態を読まずに 409 を返す */
  async #mutate<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = this.#lock.tryRun(id, task);
    if (!run) throw httpError(409, SHARED_CONTENT_BUSY);
    return run;
  }

  #requireRow(id: string): SharedContentRow {
    let row: SharedContentRow | undefined;
    try {
      row = this.#store.getSharedContent(id);
    } catch {
      throw httpError(503, SHARED_CONTENT_READ_ERROR);
    }
    if (!row) throw httpError(404, "Shared content not found");
    return row;
  }

  #requireRowCredential(row: SharedContentRow): CloudflareCredential {
    const credential = this.#requireCredentials();
    if (row.providerAccount && row.providerAccount !== credential.accountId) {
      throw httpError(409, SHARED_CONTENT_ACCOUNT_MISMATCH);
    }
    return credential;
  }

  /** 状態の保存失敗を 503 にし、provider の操作を成功として返さない */
  #persistState(
    row: SharedContentRow,
    status: SharedContentStatus,
    lastError: string | null,
    times: { publishedAt?: number | null; stoppedAt?: number | null },
  ): void {
    try {
      this.#setState(row, status, lastError, times);
    } catch (error) {
      console.warn(`[u7agent] shared content state save failed: ${this.#maskError(messageFor(error))}`);
      throw httpError(503, SHARED_CONTENT_STORE_ERROR);
    }
  }

  /**
   * 起動時に `publishing` のまま残った行を workers.dev の subdomain で照会する。
   * 確認できない行は `publishing` + lastError のまま残し、停止だけを受け付ける状態にする。
   */
  async recoverInterrupted(): Promise<void> {
    const rows = this.#store.listPublishingSharedContents();
    for (const row of rows) {
      if (!row.remoteId) {
        this.#setState(row, "failed", "公開先の情報が欠けているため再公開してください");
        continue;
      }
      const credential = this.#credentialFor(row);
      if (!credential) {
        this.#setState(row, "publishing", SHARED_CONTENT_RECONCILE_FAILED);
        continue;
      }
      try {
        const subdomain = await this.#createCloudflare(credential).getScriptSubdomain(row.remoteId);
        if (subdomain.enabled) {
          this.#setState(row, "published", "公開処理が中断しました。配信中の版は最新とは限りません", {
            publishedAt: row.publishedAt ?? this.#now(),
            stoppedAt: null,
          });
        } else {
          this.#setState(row, "stopped", "公開処理が中断しました", {
            publishedAt: row.publishedAt,
            stoppedAt: row.stoppedAt ?? this.#now(),
          });
        }
      } catch (error) {
        if (error instanceof CloudflareApiError && error.kind === "not_found") {
          this.#setState(row, "failed", "Cloudflare に公開物が見つかりません。再公開してください");
        } else {
          this.#setState(row, "publishing", SHARED_CONTENT_RECONCILE_FAILED);
        }
      }
    }
  }

  /** テスト / agent tool 用。進行中のジョブが無ければすぐ解決する */
  async waitForIdle(id: string): Promise<void> {
    // ジョブの Promise は #start が持ち、完了時に #active から消える
    while (this.#active.has(id)) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  #start(row: SharedContentRow, previousStatus: SharedContentStatus | null): void {
    this.#active.add(row.id);
    void this.#run(row, previousStatus)
      .catch((error) => {
        console.warn(`[u7agent] shared content job failed: ${this.#maskError(messageFor(error))}`);
      })
      .finally(() => {
        this.#active.delete(row.id);
      });
  }

  #startResume(row: SharedContentRow): void {
    this.#active.add(row.id);
    void this.#runResume(row)
      .catch((error) => {
        console.warn(`[u7agent] shared content resume failed: ${this.#maskError(messageFor(error))}`);
      })
      .finally(() => {
        this.#active.delete(row.id);
      });
  }

  /** 再公開は成果物を送らず、subdomain を有効に戻すだけ。版は変えないので publishedAt を進めない */
  async #runResume(row: SharedContentRow): Promise<void> {
    const credential = this.#credentialFor(row);
    if (!credential || !row.remoteId) {
      this.#setState(row, "stopped", SHARED_CONTENT_ACCOUNT_MISMATCH, {
        publishedAt: row.publishedAt,
        stoppedAt: row.stoppedAt ?? this.#now(),
      });
      return;
    }
    try {
      await this.#createCloudflare(credential).setScriptSubdomain(row.remoteId, true);
    } catch (error) {
      await this.#settleResumeFailure(row, error);
      return;
    }
    try {
      this.#setState(row, "published", null, { publishedAt: row.publishedAt, stoppedAt: null });
    } catch (error) {
      // 有効化は成功している。状態を保存できなくても publishing のまま放置せず、照会して結果不明を残す
      console.warn(`[u7agent] shared content state save failed: ${this.#maskError(messageFor(error))}`);
      try {
        await this.#reconcile(row, new SharedContentSourceError("再公開は完了しましたが、状態を保存できませんでした"));
      } catch (reconcileError) {
        console.warn(
          `[u7agent] shared content reconcile after state failure failed: ${this.#maskError(
            messageFor(reconcileError),
          )}`,
        );
      }
    }
  }

  async #run(row: SharedContentRow, previousStatus: SharedContentStatus | null): Promise<void> {
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(this.#tempRoot, "u7agent-shared-"));
      const { assets, config } = await this.#readAssets(row, tempDir);
      const credential = this.#credentialFor(row);
      if (!credential) throw new SharedContentSourceError(SHARED_CONTENT_ACCOUNT_MISMATCH);
      await this.#createCloudflare(credential).publishAssets(row.remoteId ?? "", assets, config);
      try {
        this.#store.updateSharedContentState(row.id, {
          status: "published",
          updatedAt: this.#now(),
          publishedAt: this.#now(),
          stoppedAt: null,
          lastError: null,
        });
      } catch (error) {
        // 公開は成功している。状態を保存できなくても「進行中」のまま放置せず、照会して結果不明を残す
        console.warn(`[u7agent] shared content state save failed: ${this.#maskError(messageFor(error))}`);
        try {
          await this.#reconcile(row, new SharedContentSourceError("公開は完了しましたが、状態を保存できませんでした"));
        } catch (reconcileError) {
          console.warn(
            `[u7agent] shared content reconcile after state failure failed: ${this.#maskError(messageFor(reconcileError))}`,
          );
        }
      }
    } catch (error) {
      try {
        await this.#handleFailure(row, previousStatus, error);
      } catch (stateError) {
        console.warn(`[u7agent] shared content failure state save failed: ${this.#maskError(messageFor(stateError))}`);
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #readAssets(
    row: SharedContentRow,
    tempDir: string,
  ): Promise<{ assets: CloudflareAsset[]; config: { headers?: string; redirects?: string } }> {
    const workspace = this.#workspace;
    if (!workspace) throw new SharedContentSourceError(SHARED_CONTENT_SANDBOX_UNAVAILABLE);
    const zipPath = join(tempDir, "source.zip");
    let download: Awaited<ReturnType<SandboxWorkspaceClient["downloadEntry"]>>;
    try {
      download = await workspace.downloadEntry(row.sourcePath, []);
    } catch (error) {
      throw sourceErrorFor(error);
    }
    if (!download.body) throw new SharedContentSourceError("公開する成果物を取得できませんでした");
    if (download.contentLength !== undefined && download.contentLength > SHARED_CONTENT_MAX_BYTES) {
      throw new SharedContentSourceError("公開するファイルの合計が大きすぎます（最大 100 MiB）");
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > SHARED_CONTENT_MAX_BYTES) {
          callback(new SharedContentSourceError("公開するファイルの合計が大きすぎます（最大 100 MiB）"));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(download.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        limit,
        createWriteStream(zipPath),
      );
    } catch (error) {
      if (error instanceof SharedContentSourceError) throw error;
      throw new SharedContentSourceError("公開する成果物を取得できませんでした");
    }

    let archive;
    try {
      archive = await readZipArchive(zipPath, {
        maxEntries: SHARED_CONTENT_MAX_ENTRIES,
        maxBytes: SHARED_CONTENT_MAX_BYTES,
      });
    } catch (error) {
      throw zipErrorFor(error);
    }
    const files = validateSharedAssetEntries(archive.entries);
    const assetsDir = join(tempDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const assets: CloudflareAsset[] = [];
    const config: { headers?: string; redirects?: string } = {};
    const secrets = this.#secretValues();
    for (const entry of files) {
      const target = join(assetsDir, entry.name);
      await mkdir(dirname(target), { recursive: true });
      try {
        await extractZipEntry({ archive: zipPath, entry, target, dataLimit: archive.dataLimit });
      } catch (error) {
        throw zipErrorFor(error);
      }
      const content = await readFile(target).catch(() => {
        throw new SharedContentSourceError("公開する成果物を読み取れませんでした");
      });
      if (content.length > SHARED_CONTENT_MAX_FILE_BYTES) {
        throw new SharedContentSourceError("公開するファイルが大きすぎます（1 ファイル 25 MiB まで）");
      }
      if (containsSecret(content, secrets)) {
        throw new SharedContentSourceError(
          "公開するファイルに秘密値が含まれています。ビルド成果物から値を除いてください",
        );
      }
      if (entry.name === "_headers" || entry.name === "_redirects") {
        // Cloudflare の特殊ファイルはアセットではなく metadata.assets.config へ渡す
        const text = content.toString("utf8");
        if (entry.name === "_headers") config.headers = text;
        else config.redirects = text;
        continue;
      }
      const contentType = contentTypeFor(entry.name);
      assets.push({
        path: entry.name,
        contentType,
        file: target,
        size: content.length,
        hash: cloudflareAssetHash(content, contentType),
      });
    }
    return { assets, config };
  }

  /** 停止の失敗。結果不明なら subdomain を照会し、無効なら停止済みとして確定する */
  async #settleStopFailure(
    row: SharedContentRow,
    startStatus: SharedContentStatus,
    error: unknown,
  ): Promise<SharedContentStopResponse> {
    const message = failureMessageFor(error);
    const state = isUnknownResult(error) ? await this.#subdomainStateOf(row) : null;
    if (state && "enabled" in state && !state.enabled) {
      this.#persistState(row, "stopped", null, {
        publishedAt: row.publishedAt,
        stoppedAt: row.stoppedAt ?? this.#now(),
      });
      return { id: row.id, status: "stopped" as const };
    }
    if (state && "missing" in state) {
      // 外部に公開物が無い。failed は初回公開前だけなので、開始状態へ戻して retry に委ねる
      const missing = "Cloudflare に公開物が見つかりません";
      this.#persistState(row, startStatus, missing, { publishedAt: row.publishedAt, stoppedAt: row.stoppedAt });
      throw httpError(502, missing);
    }
    const lastError = state === null && isUnknownResult(error) ? SHARED_CONTENT_RECONCILE_FAILED : message;
    this.#persistState(row, startStatus, lastError, { publishedAt: row.publishedAt, stoppedAt: row.stoppedAt });
    throw httpError(502, lastError);
  }

  /** 再公開の失敗。停止のやり直しで戻せるよう、既定では stopped + lastError に留める */
  async #settleResumeFailure(row: SharedContentRow, error: unknown): Promise<void> {
    const message = failureMessageFor(error);
    const state = isUnknownResult(error) ? await this.#subdomainStateOf(row) : null;
    const times = { publishedAt: row.publishedAt, stoppedAt: row.stoppedAt ?? this.#now() };
    if (state && "enabled" in state && state.enabled) {
      // 照会できたときだけ公開中へ確定する
      this.#setState(row, "published", null, { publishedAt: row.publishedAt, stoppedAt: null });
      return;
    }
    if (state && "missing" in state) {
      this.#setState(row, "stopped", "Cloudflare に公開物が見つかりません。削除して公開し直してください", times);
      return;
    }
    this.#setState(
      row,
      "stopped",
      state === null && isUnknownResult(error) ? SHARED_CONTENT_RECONCILE_FAILED : message,
      times,
    );
  }

  /**
   * 結果不明のあと、workers.dev の有効・無効だけを照会する。
   * 照会できなければ null (呼び出し側は状態を確定させない)。
   */
  async #subdomainStateOf(row: SharedContentRow): Promise<{ enabled: boolean } | { missing: true } | null> {
    const credential = this.#credentialFor(row);
    if (!credential || !row.remoteId) return null;
    try {
      const subdomain = await this.#createCloudflare(credential).getScriptSubdomain(row.remoteId);
      return { enabled: subdomain.enabled };
    } catch (error) {
      if (error instanceof CloudflareApiError && error.kind === "not_found") return { missing: true };
      return null;
    }
  }

  async #handleFailure(
    row: SharedContentRow,
    previousStatus: SharedContentStatus | null,
    error: unknown,
  ): Promise<void> {
    const unknown = isUnknownResult(error);
    if (unknown) {
      await this.#reconcile(row, error);
      return;
    }
    const message = failureMessageFor(error);
    if (previousStatus === "published") {
      this.#setState(row, "published", message, {
        publishedAt: row.publishedAt,
        stoppedAt: row.stoppedAt,
      });
    } else {
      this.#setState(row, "failed", message, { publishedAt: null, stoppedAt: null });
    }
  }

  /** 結果不明のときは subdomain を照会して公開中 / 停止 / 不存在へ寄せる */
  async #reconcile(row: SharedContentRow, error: unknown): Promise<void> {
    const credential = this.#credentialFor(row);
    if (!credential || !row.remoteId) {
      this.#setState(row, "publishing", SHARED_CONTENT_RECONCILE_FAILED);
      return;
    }
    try {
      const subdomain = await this.#createCloudflare(credential).getScriptSubdomain(row.remoteId);
      const message = failureMessageFor(error);
      if (subdomain.enabled) {
        this.#setState(row, "published", message, {
          publishedAt: row.publishedAt ?? this.#now(),
          stoppedAt: null,
        });
      } else {
        this.#setState(row, "stopped", message, {
          publishedAt: row.publishedAt,
          stoppedAt: row.stoppedAt ?? this.#now(),
        });
      }
    } catch (checkError) {
      if (checkError instanceof CloudflareApiError && checkError.kind === "not_found") {
        this.#setState(row, "failed", failureMessageFor(error), { publishedAt: null, stoppedAt: null });
      } else {
        this.#setState(row, "publishing", SHARED_CONTENT_RECONCILE_FAILED);
      }
    }
  }

  #setState(
    row: SharedContentRow,
    status: SharedContentStatus,
    lastError: string | null,
    times: { publishedAt?: number | null; stoppedAt?: number | null } = {},
  ): void {
    this.#store.updateSharedContentState(row.id, {
      status,
      updatedAt: this.#now(),
      publishedAt: times.publishedAt !== undefined ? times.publishedAt : row.publishedAt,
      stoppedAt: times.stoppedAt !== undefined ? times.stoppedAt : row.stoppedAt,
      lastError,
    });
  }

  #credentialFor(row: SharedContentRow): CloudflareCredential | null {
    let credential: CloudflareCredential | null;
    try {
      credential = this.#credentials.credential();
    } catch {
      // 鍵なし / 復号不能 / 破損行。行単位で「照会不能」として扱い、他の行の回収を止めない
      return null;
    }
    if (!credential) return null;
    if (row.providerAccount && row.providerAccount !== credential.accountId) return null;
    return credential;
  }

  #requireCredentials(): CloudflareCredential {
    const credential = this.#credentials.credential();
    if (!credential) throw httpError(409, SHARED_CONTENT_NO_CREDENTIALS);
    return credential;
  }

  async #requireSource(sourcePath: string): Promise<void> {
    if (!this.#workspace) throw httpError(503, SHARED_CONTENT_SANDBOX_UNAVAILABLE);
    try {
      await this.#workspace.listFiles(sourcePath);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) throw httpError(409, SHARED_CONTENT_SOURCE_REQUIRED);
      if (status === 400) throw httpError(409, "公開するディレクトリではありません");
      throw httpError(503, "公開するディレクトリを確認できませんでした");
    }
  }

  #assertSourceUnderSession(sourcePath: string, sessionCwd: string): void {
    const session = posix.isAbsolute(sessionCwd) ? sessionCwd : posix.join(this.#rootCwd, sessionCwd);
    const source = posix.join(this.#rootCwd, sourcePath);
    const relative = posix.relative(session, source);
    if (!relative || relative.startsWith("..") || posix.isAbsolute(relative)) {
      throw httpError(409, "公開元のディレクトリがセッションの作業フォルダ外へ移っています");
    }
  }
}

/** session cwd + 入力ディレクトリを workspace root 相対へ解決する。root 自身は公開できない */
export function resolveSharedContentSource(rootCwd: string, sessionCwd: string, raw: string): string {
  const directory = raw.trim();
  if (!directory) throw httpError(400, "公開するディレクトリを指定してください");
  if (directory.includes("\\") || hasControlChars(directory)) {
    throw httpError(400, "公開するディレクトリのパスが不正です");
  }
  if (posix.isAbsolute(directory)) throw httpError(400, "公開するディレクトリは相対パスで指定してください");
  const normalized = posix.normalize(directory).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw httpError(400, "公開するディレクトリのパスが不正です");
  }
  // SessionStore は登録プロジェクトの cwd を root 相対で返す。絶対パスで来た場合だけ root から落とす
  const sessionRelative = posix.isAbsolute(sessionCwd)
    ? posix.relative(rootCwd, sessionCwd)
    : posix.normalize(sessionCwd).replace(/\/+$/, "");
  if (posix.isAbsolute(sessionRelative) || sessionRelative === ".." || sessionRelative.startsWith("../")) {
    throw httpError(400, "セッションの作業フォルダがワークスペース外にあります");
  }
  const combined = posix.normalize(posix.join(sessionRelative, normalized)).replace(/\/+$/, "");
  if (
    !combined ||
    combined === "." ||
    combined.startsWith("../") ||
    posix.isAbsolute(combined) ||
    combined.length > SHARED_CONTENT_MAX_PATH_LENGTH
  ) {
    throw httpError(400, "公開するディレクトリのパスが不正です");
  }
  return combined;
}

export function normalizeSharedContentName(raw: string | undefined, sourcePath: string): string {
  const name = (raw ?? "").trim() || basename(sourcePath) || "共有コンテンツ";
  if (name.length > SHARED_CONTENT_MAX_NAME_LENGTH || hasControlChars(name)) {
    throw httpError(400, `表示名は ${SHARED_CONTENT_MAX_NAME_LENGTH} 文字以内で指定してください`);
  }
  return name;
}

/** ZIP のエントリを検証し、公開する通常ファイルだけを返す。ディレクトリと symlink は公開しない */
export function validateSharedAssetEntries(entries: readonly ZipReadEntry[]): ZipReadEntry[] {
  const seen = new Set<string>();
  const files: ZipReadEntry[] = [];
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.name.replace(/\/+$/, "") : entry.name;
    if (!isValidAssetPath(name)) {
      throw new SharedContentSourceError("公開するファイルのパスが不正です");
    }
    if (seen.has(name)) {
      throw new SharedContentSourceError("公開するファイルのパスが重複しています");
    }
    seen.add(name);
    if (entry.unixMode !== undefined) {
      // 一部の ZIP は種別ビットを書かず権限だけを持つ (0)。種別が分かる値だけを検査する
      const kind = entry.unixMode & 0o170000;
      const allowed = entry.isDirectory ? kind === 0 || kind === 0o040000 : kind === 0 || kind === 0o100000;
      if (!allowed) {
        throw new SharedContentSourceError("公開するファイルに symlink または特殊ファイルが含まれています");
      }
    }
    if (entry.isDirectory) continue;
    if (entry.size > SHARED_CONTENT_MAX_FILE_BYTES) {
      throw new SharedContentSourceError("公開するファイルが大きすぎます（1 ファイル 25 MiB まで）");
    }
    files.push(entry);
  }
  if (!files.some((entry) => entry.name === "index.html")) {
    throw new SharedContentSourceError("公開するディレクトリに index.html がありません");
  }
  return files;
}

export function isValidAssetPath(name: string): boolean {
  if (!name || name.length > SHARED_CONTENT_MAX_PATH_LENGTH || name.startsWith("/") || name.includes("\\")) {
    return false;
  }
  if (hasControlChars(name)) return false;
  const segments = name.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function containsSecret(content: Buffer, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret && content.indexOf(Buffer.from(secret, "utf8")) !== -1) return true;
  }
  return false;
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  map: "application/json; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecordLike(error)) return undefined;
  if (typeof error.status === "number") return error.status;
  if (typeof error.statusCode === "number") return error.statusCode;
  return undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sourceErrorFor(error: unknown): SharedContentSourceError {
  const status = errorStatus(error);
  if (status === 404) return new SharedContentSourceError(SHARED_CONTENT_SOURCE_REQUIRED);
  if (status === 413) return new SharedContentSourceError("公開するファイルの合計が大きすぎます（最大 100 MiB）");
  return new SharedContentSourceError("公開する成果物を取得できませんでした");
}

function zipErrorFor(error: unknown): SharedContentSourceError {
  const status = (error as { statusCode?: number }).statusCode;
  const message = error instanceof Error ? error.message : "";
  if (status === 413) {
    return new SharedContentSourceError(
      /too many/i.test(message)
        ? "公開するファイルが多すぎます（最大 10,000 件）"
        : "公開するファイルの合計が大きすぎます（最大 100 MiB）",
    );
  }
  return new SharedContentSourceError("公開する成果物を読み取れませんでした");
}

function isUnknownResult(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.kind === "timeout" ||
      error.kind === "network" ||
      error.kind === "transient" ||
      error.kind === "unverifiable")
  );
}

function failureMessageFor(error: unknown): string {
  if (error instanceof SharedContentSourceError || error instanceof CloudflareApiError) return error.message;
  return "公開に失敗しました";
}

function cloudflareFailureMessage(error: unknown): string {
  return error instanceof CloudflareApiError ? error.message : "Cloudflare に接続できませんでした";
}

function toResponse(row: SharedContentRow): SharedContentResponse {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    sourcePath: row.sourcePath,
    provider: row.provider,
    status: row.status,
    publicUrl: row.publicUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    stoppedAt: row.stoppedAt,
    lastError: row.lastError,
  };
}
