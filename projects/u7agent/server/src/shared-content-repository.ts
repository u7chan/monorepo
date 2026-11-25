/**
 * 共有コンテンツ (`shared_contents` / `shared_content_settings`) の読み書きと、行から DTO への写し。
 * 接続・トランザクション・エラーの扱い (503 / 文言のマスク / 保存値エラー) は `AppDb` が持ち、
 * ここは同じ接続を借りて SQL だけを扱う (docs/persistence.md)。サムネイルの実体は行ではなくファイル。
 */
import type { DatabaseSync } from "node:sqlite";
import { jsonArrayColumn, optionalNumber, optionalText, text, type Row } from "./db-values";

/**
 * 接続の入口。`AppDb.transaction()` の内側から呼んでも同じ接続を使う (リポジトリを跨ぐ処理でも
 * 片方だけ別の接続にならない)。
 */
export interface SharedContentDb {
  query<T>(fn: (db: DatabaseSync) => T, storedValueKey?: string): T;
}

/**
 * 公開した静的成果物の状態。値の検査はサービス側で行い、状態を増やすときに列の移行を要さないよう
 * テーブル側の CHECK にはしない (docs/static-sharing-design.md)。
 */
export type SharedContentStatus = "publishing" | "published" | "stopped" | "failed";

/**
 * 公開元の種類。`session-root` はセッションの作業フォルダ自身、`directory` はその配下のディレクトリ。
 * 公開元の表示と、作業フォルダ全体を公開したことの説明にだけ使う。
 */
export type SharedContentSourceKind = "directory" | "session-root";

/**
 * 共有物のサムネイルのメタデータ。実体は `<storeDir>/shared-thumbnails/<id>.png` に置き、
 * 行は「存在の正」だけを持つ (docs/persistence.md)。
 */
export interface SharedContentThumbnailRow {
  updatedAt: number;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Cloudflare へ公開した静的成果物の記録。管理操作の主語は u7agent 側の id で、provider 固有の識別子は
 * remoteId に閉じる。sourcePath はワークスペース root 相対で、作業フォルダが消えても行は残す
 * (docs/static-sharing-design.md#共有物のライフサイクル)。
 */
export interface SharedContentRow {
  id: string;
  /** 公開元のセッション。セッションを削除しても行は残す */
  sessionId: string;
  /** 一覧に出す表示名。URL には使わない */
  name: string;
  /** ワークスペース root 相対のディレクトリ (`""` は root) */
  sourcePath: string;
  /** 省略は `directory` (旧テストのリテラルと、列が無い時代の行を同じ形で読む) */
  sourceKind?: SharedContentSourceKind;
  provider: string;
  /** 公開先のアカウント識別子。公開の受付時に確定して保存し、以後変えない。未受付なら null */
  providerAccount: string | null;
  /** provider 側の公開単位の識別子 (Cloudflare は script 名)。受付時に確定して保存する。未受付なら null */
  remoteId: string | null;
  publicUrl: string | null;
  status: SharedContentStatus;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  stoppedAt: number | null;
  lastError: string | null;
  /** 未設定は null。列が無い時代の行も null として読む */
  thumbnail?: SharedContentThumbnailRow | null;
  /**
   * 最後に使った版。**解除しても消さない**（同じ版が再利用されると、`?v=` が衝突して
   * 差し替えがキャッシュから出なくなる）。未設定のまま一度も保存していなければ null
   */
  thumbnailVersion?: number | null;
}

/** 未知の状態は公開中 / 公開済みへ寄せず、行の破損として失敗させる */
function sharedContentStatusOf(value: unknown): SharedContentStatus {
  if (value === "publishing" || value === "published" || value === "stopped" || value === "failed") return value;
  throw new Error("shared_contents.status is invalid");
}

/** 未知の種類は公開元の表示を誤らせないよう、行の破損として失敗させる */
function sharedContentSourceKindOf(value: unknown): SharedContentSourceKind {
  if (value === "session-root" || value === "directory") return value;
  throw new Error("shared_contents.sourceKind is invalid");
}

function sharedContentOf(row: Row): SharedContentRow {
  return {
    id: text(row.id),
    sessionId: text(row.sessionId),
    name: text(row.name),
    sourcePath: text(row.sourcePath),
    sourceKind: sharedContentSourceKindOf(row.sourceKind),
    provider: text(row.provider),
    providerAccount: optionalText(row.providerAccount) ?? null,
    remoteId: optionalText(row.remoteId) ?? null,
    publicUrl: optionalText(row.publicUrl) ?? null,
    status: sharedContentStatusOf(row.status),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    publishedAt: optionalNumber(row.publishedAt),
    stoppedAt: optionalNumber(row.stoppedAt),
    lastError: optionalText(row.lastError) ?? null,
    thumbnail: sharedContentThumbnailOf(row),
    thumbnailVersion: sharedContentThumbnailVersionOf(row),
  };
}

/** 4 列が揃っている行だけをサムネイルありとして読む (手編集や途中の移行で半端な行を作らない) */
function sharedContentThumbnailVersionOf(row: Row): number | null {
  const version = optionalNumber(row.thumbnailUpdatedAt);
  return version !== null && version > 0 ? version : null;
}

function sharedContentThumbnailOf(row: Row): SharedContentThumbnailRow | null {
  const updatedAt = optionalNumber(row.thumbnailUpdatedAt);
  const width = optionalNumber(row.thumbnailWidth);
  const height = optionalNumber(row.thumbnailHeight);
  const bytes = optionalNumber(row.thumbnailBytes);
  if (updatedAt === null || width === null || height === null || bytes === null) return null;
  if (width <= 0 || height <= 0 || bytes <= 0) return null;
  return { updatedAt, width, height, bytes };
}

export class SharedContentRepository {
  constructor(private readonly db: SharedContentDb) {}

  // shared_content_settings: 1 行だけ。行が無い = 未設定

  readSharedContentExcludeNames(): string[] | undefined {
    return this.db.query((db) => {
      const row = db.prepare("SELECT * FROM shared_content_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      const names = jsonArrayColumn<string>("shared_content_settings", "excludeNames", row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、archive_settings と同じく 503 にする
      if (!names) throw new Error("shared_content_settings.excludeNames is not a JSON array");
      return names;
    }, "shared_content_settings");
  }
  saveSharedContentExcludeNames(names: readonly string[]): void {
    this.db.query((db) =>
      db
        .prepare(
          `INSERT INTO shared_content_settings (id, excludeNames) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET excludeNames = excluded.excludeNames`,
        )
        .run(JSON.stringify(names)),
    );
  }
  /** 行を消して未設定へ戻す (既定名を保存し直すと、以後の既定の更新に追随しなくなる) */
  resetSharedContentExcludeNames(): boolean {
    return this.db.query((db) => db.prepare("DELETE FROM shared_content_settings WHERE id = 1").run().changes > 0);
  }

  insertSharedContent(row: SharedContentRow): void {
    this.db.query((db) =>
      db
        .prepare(
          `INSERT INTO shared_contents
             (id, sessionId, name, sourcePath, sourceKind, provider, providerAccount, remoteId, publicUrl, status,
              createdAt, updatedAt, publishedAt, stoppedAt, lastError)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.sessionId,
          row.name,
          row.sourcePath,
          row.sourceKind ?? "directory",
          row.provider,
          row.providerAccount,
          row.remoteId,
          row.publicUrl,
          row.status,
          row.createdAt,
          row.updatedAt,
          row.publishedAt,
          row.stoppedAt,
          row.lastError,
        ),
    );
  }
  /** 状態と時刻だけを更新する。ID / ソース / provider の識別子は公開後に変えない */
  updateSharedContentState(
    id: string,
    patch: {
      status: SharedContentStatus;
      updatedAt: number;
      publishedAt: number | null;
      stoppedAt: number | null;
      lastError: string | null;
    },
  ): void {
    this.db.query((db) =>
      db
        .prepare(
          `UPDATE shared_contents
              SET status = ?, updatedAt = ?, publishedAt = ?, stoppedAt = ?, lastError = ?
            WHERE id = ?`,
        )
        .run(patch.status, patch.updatedAt, patch.publishedAt, patch.stoppedAt, patch.lastError, id),
    );
  }
  /**
   * 表示名だけを変える。`updatedAt` は触らない: 一覧の「更新」は公開ライフサイクルの時刻で、
   * 名前の変更で並びや時刻が動くと「成果物が変わった」と誤読される。
   */
  updateSharedContentName(id: string, name: string): void {
    this.db.query((db) => db.prepare("UPDATE shared_contents SET name = ? WHERE id = ?").run(name, id));
  }
  /**
   * サムネイルのメタだけを差し替える (`null` で未設定)。`updatedAt` は触らない:
   * 一覧の「更新」は公開ライフサイクルの時刻で、画像の差し替えで動くと成果物が変わったと誤読される。
   * 行が既に無ければ false を返し、呼び出し側が競合として扱えるようにする。
   */
  updateSharedContentThumbnail(id: string, thumbnail: SharedContentThumbnailRow | null): boolean {
    // 解除でも版 (`thumbnailUpdatedAt`) は残す。次に保存するときの起点が消えると、同じ版が
    // 再利用されて `?v=` とファイル名が衝突する
    return this.db.query((db) => {
      if (thumbnail === null) {
        return (
          db
            .prepare(
              `UPDATE shared_contents
                  SET thumbnailWidth = NULL, thumbnailHeight = NULL, thumbnailBytes = NULL
                WHERE id = ?`,
            )
            .run(id).changes > 0
        );
      }
      return (
        db
          .prepare(
            `UPDATE shared_contents
                SET thumbnailUpdatedAt = ?, thumbnailWidth = ?, thumbnailHeight = ?, thumbnailBytes = ?
              WHERE id = ?`,
          )
          .run(thumbnail.updatedAt, thumbnail.width, thumbnail.height, thumbnail.bytes, id).changes > 0
      );
    });
  }
  /**
   * 実体が見つからなかったときの未設定化。読んだ後に行が差し替わっていたら何もしない
   * （古い GET の不在補正が新しい版を消さないよう、版が一致する行だけを消す）。
   */
  clearSharedContentThumbnail(id: string, expectedUpdatedAt: number): boolean {
    return this.db.query(
      (db) =>
        db
          .prepare(
            `UPDATE shared_contents
                  SET thumbnailWidth = NULL, thumbnailHeight = NULL, thumbnailBytes = NULL
                WHERE id = ? AND thumbnailUpdatedAt = ?`,
          )
          .run(id, expectedUpdatedAt).changes > 0,
    );
  }
  getSharedContent(id: string): SharedContentRow | undefined {
    const row = this.db.query(
      (db) => db.prepare("SELECT * FROM shared_contents WHERE id = ?").get(id) as Row | undefined,
    );
    return row ? sharedContentOf(row) : undefined;
  }
  listSharedContents(sessionId?: string): SharedContentRow[] {
    return this.db.query((db) =>
      (
        (sessionId === undefined
          ? db.prepare("SELECT * FROM shared_contents ORDER BY createdAt DESC, id DESC").all()
          : db
              .prepare("SELECT * FROM shared_contents WHERE sessionId = ? ORDER BY createdAt DESC, id DESC")
              .all(sessionId)) as Row[]
      ).map(sharedContentOf),
    );
  }
  listPublishingSharedContents(): SharedContentRow[] {
    return this.db.query((db) =>
      (
        db.prepare("SELECT * FROM shared_contents WHERE status = 'publishing' ORDER BY createdAt ASC").all() as Row[]
      ).map(sharedContentOf),
    );
  }
  /** 行を消す。provider 側の削除が成功したあとにだけ呼ぶ */
  deleteSharedContent(id: string): void {
    this.db.query((db) => db.prepare("DELETE FROM shared_contents WHERE id = ?").run(id));
  }
  /**
   * 別のアカウントで公開した共有物が残っているか。未受付 (providerAccount が NULL) の行は
   * まだ何も公開していないため対象外にする。
   */
  hasSharedContentsForOtherAccount(accountId: string): boolean {
    const row = this.db.query(
      (db) =>
        db
          .prepare(
            "SELECT 1 AS found FROM shared_contents WHERE providerAccount IS NOT NULL AND providerAccount <> ? LIMIT 1",
          )
          .get(accountId) as Row | undefined,
    );
    return row !== undefined;
  }
}
