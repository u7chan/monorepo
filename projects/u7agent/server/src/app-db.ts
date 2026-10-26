/**
 * アプリデータ (プロジェクト / エージェント / 設定) の SQLite ストア。
 * 置き場所・スキーマの作り直し・失敗時の扱いは docs/persistence.md を正とする。
 * スキル定義はこの DB ではなくファイル (`.agents/skills`) を正とする。
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spaceDirRel } from "./app-paths";
import { httpError, messageFor } from "./http";
import type { ImageInputDeclaration } from "./images";
import type { SecretKind } from "./secret-crypto";
import type { AgentDef, AgentSuggestion, ModelRef, NotificationResult, Project, Space } from "./schema";

export const APP_DB_FILENAME = "u7agent.db";
/** テーブル定義を変えたら上げる。新規作成と加算移行はこの版へ揃え、未知の版は作り直す */
export const APP_DB_SCHEMA_VERSION = 31;

/**
 * AEAD で保存する値の保存形。GCM の認証タグは ciphertext の末尾に含む。
 * 方式と AAD の規約は docs/secrets.md を正とする。
 */
export interface StoredAppSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
}

/** 列がすべて揃っているときだけ保存形へ写す (欠けた行は「未保存」と読み違えないよう例外にする) */
function storedAppSecretOf(
  row: Row,
  table: string,
  columns: { ciphertext: string; nonce: string; keyVersion: string } = {
    ciphertext: "ciphertext",
    nonce: "nonce",
    keyVersion: "keyVersion",
  },
): StoredAppSecret | null {
  const ciphertext = optionalBlob(row[columns.ciphertext]);
  const nonce = optionalBlob(row[columns.nonce]);
  const keyVersion = optionalNumber(row[columns.keyVersion]);
  const present = [ciphertext !== null, nonce !== null, keyVersion !== null];
  if (present.every((value) => !value)) return null;
  if (!ciphertext || !nonce || keyVersion === null || !Number.isInteger(keyVersion)) {
    throw new Error(`${table} secret columns are incomplete`);
  }
  return { ciphertext, nonce, keyVersion };
}

/** プロバイダー API キーの保存行。値は AEAD の暗号文で、復号は docs/secrets.md の契約に従う */
export interface ProviderCredentialRow extends StoredAppSecret {
  provider: string;
  /** 最終保存時刻 (epoch ms)。NULL は移行前の行で不明 */
  updatedAt: number | null;
}

/** プロバイダーに紐づく人間用メモの保存行。空文字の行は未設定として返す (optionalText) */
export interface ProviderMemoRow {
  provider: string;
  memo: string;
}

/**
 * 利用可能なモデル / アプリ既定モデルの保存行。allowedModels の null は制限なし、
 * defaultModel の null は「既定なし」を表す (候補の先頭では代用しない)
 */
export interface ModelSettingsRow {
  allowedModels: ModelRef[] | null;
  defaultModel: string | null;
}

/**
 * コンテンツ生成の保存行。**行が無い = 未設定**で、キー削除は行ごと消す。APIキーは AEAD の暗号文で、
 * 3 列がすべて NULL = キー未設定 (契約は docs/secrets.md / docs/image-generation.md)。
 * `enabled` はアプリ全体の有効 / 無効で、v25 -> v26 で足した列（既存行は ON）。OFF でも行は残すため、
 * キーと選択は消えない（削除は別操作）。
 * 音声の 2 列は v15 -> v16 で足した nullable 列で、NULL は既定（モデル）と「宣言する先頭ボイス」
 * （voice）へフォールバックして読む。
 */
export interface ContentSettingsRow {
  provider: string;
  imageModel: string;
  speechModel: string | null;
  speechVoice: string | null;
  enabled: boolean;
  /** APIキーの暗号文。null = キー未設定 */
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  keyVersion: number | null;
}

/** アプリデータの SQLite に保存する通知設定。Webhook URL は AEAD の暗号文で、応答へは出さない (write-only) */
export interface NotificationSettingsRow {
  enabled: boolean;
  askUser: boolean;
  /** Webhook URL の暗号文。null = 未設定 (通知は送らない) */
  webhook: StoredAppSecret | null;
  baseUrl: string | null;
  lastResult: NotificationResult | null;
}

/**
 * Web 検索の設定の保存行。**行が無い = 既定（有効 / Exa）**で、行があるときは enabled と provider が正。
 * 保存値は 0 / 1 のどちらかで、API では boolean に読み替える。provider は未知の値もそのまま返し、
 * 既定への畳み込みはサービス側で行う（docs/web-search.md）。
 */
export interface WebSearchSettingsRow {
  enabled: boolean;
  provider: string;
}

/**
 * 会話タイトルの AI 要約の保存行。**行が無い = 既定 (Off・モデル未選択・定義は既定文)**。
 * model は `provider/id` で、本会話のモデルとは独立に選ぶ。定義は編集可能な指示で、固定指示は
 * アプリ側の実装が持ち、この行では解除できない (docs/session-title.md)。
 */
export interface TitleSummarySettingsRow {
  enabled: boolean;
  /** `provider/id`。null は未選択 */
  model: string | null;
  /** 保存済みの Effort。null は未指定 (実行時にモデルの最小段階へフォールバックする) */
  thinkingLevel: string | null;
  definition: string;
}

/** カタログ 1 件の保存形。provider は v1 では openrouter 固定なので id と表示名、あれば形式 / 入力の宣言を残す */
export interface ImageCatalogModelRow {
  id: string;
  name: string;
  /** live が宣言する出力形式。無い行（この項目より前のキャッシュ）は「宣言なし」として読む */
  outputFormats?: string[] | undefined;
  /** live が宣言する画像入力の能力。無い行（この項目より前のキャッシュ）は「不明」として読む */
  input?: ImageInputDeclaration | undefined;
}

/**
 * live カタログのキャッシュ行。**行が無い = 取得できていない**で、SDK 同梱カタログへ落ちる。
 * 利用者データではなくキャッシュなので、壊れた行は未保存として扱い、設定 API を 503 にしない。
 */
export interface ImageCatalogRow {
  /** 最後に live を取得できた時刻 (epoch ms) */
  fetchedAt: number;
  models: ImageCatalogModelRow[];
}

/** 音声カタログ 1 件の保存形。provider は v1 では openrouter 固定なので id と表示名、話者の宣言を残す */
export interface SpeechCatalogModelRow {
  id: string;
  name: string;
  /** live が宣言する話者。無い行（宣言の無いモデル・この項目より前のキャッシュ）は「宣言なし」として読む */
  voices?: string[] | undefined;
}

/**
 * live 音声カタログのキャッシュ行。テーブルの形は `image_catalog` と同型だが、item の JSON は違う
 * （`voices` を持つ）。行が無い = 取得できておらず、同梱の既定 1 件へ落ちる。
 */
export interface SpeechCatalogRow {
  /** 最後に live を取得できた時刻 (epoch ms) */
  fetchedAt: number;
  models: SpeechCatalogModelRow[];
}

/**
 * serve (サービス) の起動実績。**作業ディレクトリ単位**で、同じプロジェクトの他会話でも使える。
 * 稼働記録 (誰が動かしているか) ではないため、プロセスが消えても残る。
 */
export interface ServeCommandRow {
  /** ワークスペース root 相対の作業ディレクトリ (`""` は root) */
  cwd: string;
  command: string;
  updatedAt: number;
}

/**
 * 作業フォルダ単位の環境変数。所有者は cwd で、`serve_commands` と同じキー空間。
 * 種別ごとに使う列が排他で、`variable` は plaintext、`secret` は ciphertext / nonce / keyVersion。
 * 暗号化の書式と、値の再取得を許さない契約は docs/secrets.md を正とする。
 */
export interface SecretRow {
  secretId: string;
  /** ワークスペース root 相対の作業ディレクトリ (`""` は root) */
  cwd: string;
  /** 正規化済み (大文字)。変更できないため AEAD の AAD に含めてよい */
  name: string;
  kind: SecretKind;
  /** kind='variable' のときだけ値を持つ */
  plaintext: string | null;
  /** kind='secret' の暗号文 (GCM の認証タグを末尾に含む) */
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  keyVersion: number | null;
  /** 表示順。cwd 内で昇順 (削除しても詰めない) */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 公開した静的成果物の状態。値の検査はサービス側で行い、状態を増やすときに列の移行を要さないよう
 * テーブル側の CHECK にはしない (docs/static-sharing.md)。
 */
export type SharedContentStatus = "publishing" | "published" | "stopped" | "failed";

/**
 * Cloudflare へ公開した静的成果物の記録。管理操作の主語は u7agent 側の id で、provider 固有の識別子は
 * remoteId に閉じる。sourcePath はワークスペース root 相対で、作業フォルダが消えても行は残す
 * (docs/static-sharing.md)。
 */
/**
 * 公開元の種類。`session-root` はセッションの作業フォルダ自身、`directory` はその配下のディレクトリ。
 * 公開元の表示と、作業フォルダ全体を公開したことの説明にだけ使う。
 */
export type SharedContentSourceKind = "directory" | "session-root";

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
}

/**
 * Cloudflare の資格情報。**行が無い = 未登録**で、BFF 専用 (agent / sandbox へ渡さない)。
 * 暗号化の書式は `secrets` と同じ AES-256-GCM を再利用する (docs/static-sharing.md)。
 */
export interface CloudflareSettingsRow {
  accountId: string;
  /** 認証トークンの暗号文 (GCM の認証タグを末尾に含む) */
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
  updatedAt: number;
}

export interface AppDbStatus {
  /** null は永続化なし (メモリ DB)。開けなかったときも null */
  path: string | null;
  ok: boolean;
  error?: string;
}

/** セッションの引っ越しが使う、cwd をキーにする行の付け替えだけの狭い IF */
export type CwdKeyStore = Pick<AppDb, "moveCwd">;

export interface OpenAppDbOptions {
  /** 会話ストアと同じディレクトリ。null ならメモリ DB (テスト) */
  storeDir: string | null;
  /**
   * ログと health / 503 に載る DB エラー文言の境界。bootstrap が可変マスカーを渡し、
   * 登録済みのAPIキーが例外文言へ現れても生のまま記録しない。未指定は identity (テストの明示 opt-out)。
   */
  sanitizeError?: (text: string) => string;
}

// 既存 DB のテーブル再構築を避けるため旧 mention 列は残し、現行アプリからは参照しない。
/**
 * v1 -> v2 で足したテーブル。`IF NOT EXISTS` で定義を 1 つに保ち、新規作成と加算移行の両方から使う
 * (加算移行では既存の projects / agents / skills を消さない)。
 * Webhook URL は v30 -> v31 で `webhookCiphertext` / `webhookNonce` / `webhookKeyVersion` へ移した。
 */
const NOTIFICATION_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL,
  askUser INTEGER NOT NULL DEFAULT 1,
  webhookCiphertext BLOB,
  webhookNonce BLOB,
  webhookKeyVersion INTEGER,
  baseUrl TEXT,
  mention TEXT NOT NULL,
  lastResult TEXT
);
`;

/**
 * v2 -> v3 で足したテーブル。除外名は JSON 配列テキストで、**行が無い = 未設定**（実効値は既定）。
 * 明示空（`[]`）と区別するため、既定へ戻すときは行ごと消す。
 */
const ARCHIVE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS archive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  excludeNames TEXT NOT NULL
);
`;

/**
 * v3 -> v4 で足したテーブル。GUI から登録したプロバイダー API キーを 1 行 1 プロバイダーで持つ。
 * APIキーは v30 -> v31 で AEAD の暗号文 (`ciphertext` / `nonce` / `keyVersion`) だけを持つキー専用テーブルへ
 * 作り直した (v6 -> v7 で足した `updatedAt` も作り直しで NOT NULL へ揃えた)。
 * 値は必ずバインドして渡す (SQL 文字列へ埋め込まない)。
 */
const PROVIDER_CREDENTIALS_TABLE = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider   TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  keyVersion INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);
`;

/**
 * v4 -> v5 で足したテーブル。利用可能なモデルは JSON 配列テキストで、**行が無い = 未設定**。
 * 空配列も未設定 (制限なし) へ正規化するため、両方が null の保存は行ごと消す。
 */
const MODEL_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowedModels TEXT,
  defaultModel TEXT
);
`;

/**
 * v5 -> v6 で足したテーブル。provider に紐づく人間用メモで、**行が無い = 未設定**。
 * credential とは別テーブルにし、キーの登録有無 (managed) とメモを混ぜない。
 */
const PROVIDER_MEMOS_TABLE = `
CREATE TABLE IF NOT EXISTS provider_memos (
  provider TEXT PRIMARY KEY,
  memo     TEXT NOT NULL
);
`;

/**
 * v7 -> v8 で足したテーブル。v14 -> v15 で `image_settings`（provider / model / apiKey）から
 * コンテンツ生成の `content_settings`（provider / imageModel / ...）へ改名した。
 * 1 行だけ持ち、**行が無い = 未設定**（キー削除は行ごと消す）。provider_credentials とは別管理にし、
 * プロバイダー登録キーを生成へ流用しない（docs/image-generation.md）。
 * APIキーは v30 -> v31 で平文列から AEAD の暗号文へ移し、3 列 NULL = キー未設定にした。
 * 音声の `speechModel` / `speechVoice` は v15 -> v16 の列追加で、既存行は NULL になる
 * （NULL は既定へフォールバックする。docs/speech-generation.md）。
 */
const CONTENT_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS content_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  provider    TEXT NOT NULL,
  imageModel  TEXT NOT NULL,
  speechModel TEXT,
  speechVoice TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  ciphertext  BLOB,
  nonce       BLOB,
  keyVersion  INTEGER
);
`;

/**
 * v8 -> v9 で足したテーブル。取得に失敗した起動でも前回の一覧を出せるように、
 * 最後に成功した live カタログを 1 行だけ残す (docs/image-generation.md)。
 */
const IMAGE_CATALOG_TABLE = `
CREATE TABLE IF NOT EXISTS image_catalog (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  fetchedAt INTEGER NOT NULL,
  models    TEXT NOT NULL
);
`;

/**
 * v15 -> v16 で足したテーブル。`image_catalog` と同型で、音声モデルの live 一覧を 1 行だけ残す
 * （item の JSON は `voices` を含むため違う。docs/speech-generation.md）。
 */
const SPEECH_CATALOG_TABLE = `
CREATE TABLE IF NOT EXISTS speech_catalog (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  fetchedAt INTEGER NOT NULL,
  models    TEXT NOT NULL
);
`;

/**
 * v9 -> v10 で足したテーブル。serve の起動に成功したコマンドを作業ディレクトリ単位で持つ
 * (**行が無い = 実績なし**)。稼働記録 (サンドボックスの作業領域) とは別物で、こちらは実績の再利用だけに使う。
 */
const SERVE_COMMANDS_TABLE = `
CREATE TABLE IF NOT EXISTS serve_commands (
  cwd       TEXT PRIMARY KEY,
  command   TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
`;

/**
 * v10 -> v11 で足したテーブル。作業フォルダ (cwd) 単位の環境変数で、`serve_commands` と同じキー空間。
 *
 * **このテーブルは列追加だけの加算移行を恒久ルールとする** (削除・リネーム・作り直しをしない)。
 * 秘密が消える移行は、たとえ古い版へ戻す経路でも許さない。`DROP_TABLES` にも入れない:
 * 古いビルドへ戻したとき (#recreate) はこのテーブルを知らないので放置され、新ビルドへ戻すと
 * #migrate() の `CREATE TABLE IF NOT EXISTS` がそのまま合流させる。
 */
const SECRETS_TABLE = `
CREATE TABLE IF NOT EXISTS secrets (
  secretId    TEXT PRIMARY KEY,
  cwd         TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  plaintext   TEXT,
  ciphertext  BLOB,
  nonce       BLOB,
  keyVersion  INTEGER,
  sortOrder   INTEGER NOT NULL,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  UNIQUE (cwd, name)
);
`;

/**
 * v11 -> v12 で足したテーブル。`web_search` の有効 / 無効と既定 provider を 1 行だけ持ち、
 * **行が無い = 既定（有効 / exa）**。コンテンツ生成（`content_settings`）と並ぶツール公開の状態で、
 * 行があるときは `enabled` と `provider` が正。`provider` の列は v12 -> v13 で足した（docs/web-search.md）。
 */
const WEB_SEARCH_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS web_search_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  enabled  INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'exa'
);
`;

/**
 * v12 -> v13 で足したテーブル。provider ごとの APIキーを 1 行 1 provider で持ち、
 * **行が無い = キー未設定**（削除は行ごと消す）。できれば 1 列にまとめたくない理由は、
 * キー付きの provider が増えたときに「このキーはどの provider のものか」を列が表せないため。
 * v30 -> v31 で AEAD の暗号文 (`ciphertext` / `nonce` / `keyVersion`) だけを持つ形へ作り直した。
 */
const WEB_SEARCH_PROVIDER_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS web_search_provider_keys (
  provider   TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  keyVersion INTEGER NOT NULL
);
`;

/**
 * v24 -> v25 で足したテーブル。会話タイトルの AI 要約の設定を 1 行だけ持つ。
 * **行が無い = 既定 (Off / モデル未選択 / 既定の定義)**。本会話のモデルや compaction の要約とは別の設定。
 */
const TITLE_SUMMARY_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS title_summary_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enabled       INTEGER NOT NULL,
  model         TEXT,
  thinkingLevel TEXT,
  definition    TEXT NOT NULL
);
`;

/**
 * provider メモは retainSecret に登録しない方針なので、SQLite の例外文言に値が写り得る。
 * ログ・health・503 へは、この値を含まない固定文言だけを渡す。
 */
const PROVIDER_MEMO_QUERY_FAILED = "provider memo query failed";

/**
 * 暗号文を読むクエリの失敗文言。暗号文・平文を例外文言へ反射させられても、ログ・health・503 へは
 * この固定文言だけを渡す (可変マスカーは暗号文の hex / base64 を守れない)。
 */
const APP_SECRET_QUERY_FAILED = "app secret query failed";

const SPACES_TABLE = `CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, sortOrder INTEGER
);`;

/**
 * v23 -> v24 で足したテーブル。Cloudflare へ公開した静的成果物を 1 行 1 共有物で持つ。
 *
 * **このテーブルは削除・リネームをしない加算移行の対象で、`DROP_TABLES` に入れない**: 行が消えると
 * Cloudflare 側に公開物が残ったまま追跡・停止・削除できなくなる。`secrets` と同じ理由で、古いビルドへ
 * 戻したとき (#recreate) は放置され、新ビルドで `CREATE TABLE IF NOT EXISTS` が合流させる。
 * providerAccount は公開先のアカウントで、資格情報を入れ替えても既存行の追跡先を変えないために持つ。
 */
const SHARED_CONTENTS_TABLE = `
CREATE TABLE IF NOT EXISTS shared_contents (
  id          TEXT PRIMARY KEY,
  sessionId   TEXT NOT NULL,
  name        TEXT NOT NULL,
  sourcePath  TEXT NOT NULL,
  sourceKind  TEXT NOT NULL DEFAULT 'directory',
  provider    TEXT NOT NULL,
  providerAccount TEXT,
  remoteId    TEXT,
  publicUrl   TEXT,
  status      TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  publishedAt INTEGER,
  stoppedAt   INTEGER,
  lastError   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_contents_remote ON shared_contents (provider, providerAccount, remoteId);
`;

/**
 * v23 -> v24 で足したテーブル。Cloudflare の資格情報を 1 行だけ持ち、**行が無い = 未登録**。
 * `secrets` と同じく `DROP_TABLES` に入れない (暗号文を移行経路で失わない)。
 */
const CLOUDFLARE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS cloudflare_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  accountId  TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  keyVersion INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);
`;

/**
 * v26 -> v27 で足したテーブル。共有の除外名は JSON 配列テキストで、**行が無い = 未設定**（実効値は既定）。
 * 明示空（`[]`）と区別するため、既定へ戻すときは行ごと消す。
 *
 * **`DROP_TABLES` に入れない**: 行が消えると利用者の除外が既定へ戻り、次の更新で公開範囲が意図せず変わる
 * （`shared_contents` と同じ扱い。古いビルドへ戻したとき (#recreate) は放置され、新ビルドで
 * `CREATE TABLE IF NOT EXISTS` が合流させる）。
 */
const SHARED_CONTENT_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS shared_content_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  excludeNames TEXT NOT NULL
);
`;

const CREATE_TABLES = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  systemPrompt TEXT NOT NULL,
  icon TEXT,
  model TEXT,
  thinkingLevel TEXT,
  suggestions TEXT,
  commonSkillNames TEXT,
  builtinSkillNames TEXT,
  toolNames TEXT,
  allowNaturalInvocation INTEGER,
  sortOrder INTEGER
);
${NOTIFICATION_SETTINGS_TABLE}
${ARCHIVE_SETTINGS_TABLE}
${PROVIDER_CREDENTIALS_TABLE}
${MODEL_SETTINGS_TABLE}
${PROVIDER_MEMOS_TABLE}
${CONTENT_SETTINGS_TABLE}
${IMAGE_CATALOG_TABLE}
${SPEECH_CATALOG_TABLE}
${SERVE_COMMANDS_TABLE}
${WEB_SEARCH_SETTINGS_TABLE}
${WEB_SEARCH_PROVIDER_KEYS_TABLE}
${TITLE_SUMMARY_SETTINGS_TABLE}
${SECRETS_TABLE}
${SHARED_CONTENTS_TABLE}
${CLOUDFLARE_SETTINGS_TABLE}
${SHARED_CONTENT_SETTINGS_TABLE}
${SPACES_TABLE}`;

/** アプリ所有のテーブルだけを落とす (同じ DB に足した別機能のテーブルを巻き込まない) */
const DROP_TABLES = `
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS archive_settings;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS model_settings;
DROP TABLE IF EXISTS provider_memos;
DROP TABLE IF EXISTS content_settings;
DROP TABLE IF EXISTS image_catalog;
DROP TABLE IF EXISTS speech_catalog;
DROP TABLE IF EXISTS serve_commands;
DROP TABLE IF EXISTS web_search_settings;
DROP TABLE IF EXISTS web_search_provider_keys;
DROP TABLE IF EXISTS title_summary_settings;
`;
// secrets / shared_contents / cloudflare_settings / shared_content_settings は意図的に含めない
// (docs/secrets.md / docs/static-sharing.md)。
// 列追加も #migrate() にだけ足し、既存行を書き換える移行はしない。

/**
 * DB を新規作成したときだけ入れるサンプル定義 (作り直しでは入れない)。
 * 口調のように会話全体へ常時効かせたい指示はスキルではなくエージェントの systemPrompt に置く。
 */
const SEED_AGENTS: AgentDef[] = [
  {
    id: "agent-zundamon",
    name: "ずんだもん",
    description: "「〜なのだ」「〜のだ」の語尾で話す",
    systemPrompt:
      "ずんだもんの口調で話してください。文末は「〜なのだ」「〜のだ」にし、一人称は「ボク」を使ってください。内容や説明の正確さは変えず、口調だけを変えてください。コード・コマンド・ファイルパス・エラーメッセージは書き換えず、そのまま示してください。",
  },
];

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** NULL を不明のまま読む (移行前の行を 0 と混同しない) */
function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** 自分で書いた JSON 列だけを読む。壊れていたら黙って空にせず例外にして 503 側で見せる */
function jsonArray<T>(value: unknown): T[] | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

function jsonObject<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
}

/**
 * 保存行の JSON 配列を読む。JSON.parse の文言は値の断片を写すため、テーブル / 列だけを示して
 * 503 へ渡す (health とログで、どの行を直せばよいか分かるようにする)。
 */
function jsonArrayColumn<T>(table: string, column: string, value: unknown): T[] | undefined {
  try {
    return jsonArray<T>(value);
  } catch {
    throw new Error(`${table}.${column} is not valid JSON`);
  }
}

function projectOf(row: Row): Project {
  return {
    id: text(row.id),
    name: text(row.name),
    cwd: text(row.cwd),
    createdAt: Number(row.createdAt),
  };
}

function providerCredentialOf(row: Row): ProviderCredentialRow {
  const secret = storedAppSecretOf(row, "provider_credentials");
  // 暗号文の欠けた行を「未登録」と読み違えて上書きしない (サービスが 503 へ変換し、削除だけは通す)
  if (!secret) throw new Error("provider_credentials row is incomplete");
  return { provider: text(row.provider), ...secret, updatedAt: optionalNumber(row.updatedAt) };
}

/** 空文字の行は未設定として落とす (手編集された DB を「メモあり」と読み違えない) */
function providerMemoOf(row: Row): ProviderMemoRow | undefined {
  const memo = optionalText(row.memo);
  return memo === undefined ? undefined : { provider: text(row.provider), memo };
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
  };
}

/** 手編集で空文字にされた provider / imageModel の行は未設定として読む (メモと同じ規約) */
function contentSettingsOf(row: Row): ContentSettingsRow | undefined {
  const provider = optionalText(row.provider);
  const imageModel = optionalText(row.imageModel);
  if (!provider || !imageModel) return undefined;
  // 暗号文が NULL = キー未設定。3 列の片方だけが埋まった行は保存値の破損として失敗させる
  const secret = storedAppSecretOf(row, "content_settings");
  return {
    provider,
    imageModel,
    // 空文字も NULL と同じく「未設定」として既定へフォールバックさせる
    speechModel: optionalText(row.speechModel) ?? null,
    speechVoice: optionalText(row.speechVoice) ?? null,
    // 足した列なので、手編集で NULL にされた行も既定 (ON) として読む
    enabled: Number(row.enabled) !== 0,
    ciphertext: secret?.ciphertext ?? null,
    nonce: secret?.nonce ?? null,
    keyVersion: secret?.keyVersion ?? null,
  };
}

/**
 * キャッシュ行の JSON 配列。派生データなので、JSON が壊れていても、形が違っても、空でも「未取得」として読む
 * (保存値の破損として health / 503 にはしない。読めなければ SDK カタログへ落ち、次の取得成功が行を上書きして直る)。
 */
function imageCatalogModelsOf(value: unknown): ImageCatalogModelRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const models: ImageCatalogModelRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name, outputFormats, input } = entry as {
      id?: unknown;
      name?: unknown;
      outputFormats?: unknown;
      input?: unknown;
    };
    if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
    // 形式 / 入力の宣言は任意フィールド。形が違えば「宣言なし」として読み、id / 表示名が正しい行まで捨てない
    const formats = Array.isArray(outputFormats)
      ? outputFormats.filter((format): format is string => typeof format === "string" && format !== "")
      : [];
    const declaration = imageInputDeclarationOf(input);
    models.push({
      id,
      name,
      ...(formats.length > 0 ? { outputFormats: formats } : {}),
      ...(declaration ? { input: declaration } : {}),
    });
  }
  return models;
}

/** 旧キャッシュの入力宣言。読めた項目だけを残し、1 つも読めなければ「不明」（鍵ごと落とす）にする */
function imageInputDeclarationOf(value: unknown): ImageInputDeclaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { modalities, references, endpoints } = value as {
    modalities?: unknown;
    references?: unknown;
    endpoints?: unknown;
  };
  const modalityList = Array.isArray(modalities)
    ? modalities.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  const endpointList = Array.isArray(endpoints)
    ? endpoints.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  const range = (() => {
    if (typeof references !== "object" || references === null) return undefined;
    const { min, max } = references as { min?: unknown; max?: unknown };
    if (typeof min !== "number" || typeof max !== "number") return undefined;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return undefined;
    return { min, max };
  })();
  if (modalityList.length === 0 && !range && endpointList.length === 0) return undefined;
  return {
    ...(modalityList.length > 0 ? { modalities: modalityList } : {}),
    ...(range ? { references: range } : {}),
    ...(endpointList.length > 0 ? { endpoints: endpointList } : {}),
  };
}

/**
 * 音声キャッシュ行の JSON 配列。`image_catalog` と同じく派生データなので、JSON が壊れていても、
 * 形が違っても、空でも「未取得」として読む（同梱の既定カタログへ落ち、次の取得成功が行を上書きする）。
 */
function speechCatalogModelsOf(value: unknown): SpeechCatalogModelRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const models: SpeechCatalogModelRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name, voices } = entry as { id?: unknown; name?: unknown; voices?: unknown };
    if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
    // 話者の宣言は任意フィールド。形が違えば「宣言なし」として読み、id / 表示名が正しい行まで捨てない
    const names = Array.isArray(voices)
      ? voices.filter((voice): voice is string => typeof voice === "string" && voice !== "")
      : [];
    models.push(names.length > 0 ? { id, name, voices: names } : { id, name });
  }
  return models;
}

function serveCommandOf(row: Row): ServeCommandRow {
  return { cwd: text(row.cwd), command: text(row.command), updatedAt: Number(row.updatedAt) };
}

/** BLOB 列は Uint8Array。手編集で TEXT にされた行は「保存値が欠けている」として null で読む */
function optionalBlob(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

/** 未知の種別は秘密側へ寄せる (復号できない行を平文として扱わない) */
function secretOf(row: Row): SecretRow {
  return {
    secretId: text(row.secretId),
    cwd: text(row.cwd),
    name: text(row.name),
    kind: row.kind === "variable" ? "variable" : "secret",
    plaintext: typeof row.plaintext === "string" ? row.plaintext : null,
    ciphertext: optionalBlob(row.ciphertext),
    nonce: optionalBlob(row.nonce),
    keyVersion: row.keyVersion === null || row.keyVersion === undefined ? null : Number(row.keyVersion),
    sortOrder: Number(row.sortOrder),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function notificationSettingsOf(row: Row): NotificationSettingsRow {
  const baseUrl = optionalText(row.baseUrl);
  const lastResult = jsonObject<NotificationResult>(row.lastResult);
  return {
    enabled: Number(row.enabled) === 1,
    // 列の無い旧 DB と NULL は既定 (ON) として読む
    askUser: row.askUser === null || row.askUser === undefined ? true : Number(row.askUser) === 1,
    // URL は暗号文だけを持ち、GET では復号しない (復号は起動時と保存 / 置換のときだけ)
    webhook: storedAppSecretOf(row, "notification_settings", {
      ciphertext: "webhookCiphertext",
      nonce: "webhookNonce",
      keyVersion: "webhookKeyVersion",
    }),
    baseUrl: baseUrl ?? null,
    lastResult: lastResult ?? null,
  };
}

function agentOf(row: Row): AgentDef {
  const agent: AgentDef = {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    systemPrompt: text(row.systemPrompt),
  };
  const icon = optionalText(row.icon);
  const model = jsonObject<ModelRef>(row.model);
  const thinkingLevel = optionalText(row.thinkingLevel);
  const suggestions = jsonArray<AgentSuggestion>(row.suggestions);
  const commonSkillNames = agentSkillNames(row, "commonSkillNames");
  const builtinSkillNames = agentSkillNames(row, "builtinSkillNames");
  const toolNames = agentSkillNames(row, "toolNames");
  // 未指定の項目はキーごと省略する (応答に null は現れない)
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel as AgentDef["thinkingLevel"];
  if (suggestions?.length) agent.suggestions = suggestions;
  if (commonSkillNames) agent.commonSkillNames = commonSkillNames;
  if (builtinSkillNames) agent.builtinSkillNames = builtinSkillNames;
  if (toolNames) agent.toolNames = toolNames;
  // NULL = 既定 (自然文でも発火する)、0 = false。1 は保存しない (true は NULL へ正規化する)
  if (row.allowNaturalInvocation === 0) agent.allowNaturalInvocation = false;
  return agent;
}

/**
 * 許可リストの列。NULL = 未指定 (全可視 / 全部 ON) と `"[]"` = すべて OFF を区別する。
 * 行がある以上 NULL 以外は JSON 配列のはずなので、壊れた値は未指定へ黙って落とさず失敗させる
 * (model_settings.allowedModels と同じ形)。
 */
function agentSkillNames(
  row: Row,
  column: "commonSkillNames" | "builtinSkillNames" | "toolNames",
): string[] | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  const names = jsonArrayColumn<string>("agents", column, value);
  if (!names) throw new Error(`agents.${column} is not a JSON array`);
  return names;
}

/**
 * DB を持てない状態でもインスタンスを返し、クエリで 503 を投げる (メモリ DB へは逃がさない)。
 * 理由は health へ出し、ルートはこの例外で 503 になる。
 */
export class AppDb {
  #db: DatabaseSync | null;
  #path: string | null;
  #error: string | undefined;
  /**
   * 壊れた保存値のように、別テーブルの読取成功で消してはいけない失敗。テーブル名ごとに持ち、
   * 同じテーブルの読取が成功したときだけ解除する。一過性の失敗 (#error) と違い probe() では消えない。
   */
  #storedValueErrors = new Map<string, string>();
  #sanitizeError: (text: string) => string;

  private constructor(
    db: DatabaseSync | null,
    path: string | null,
    sanitizeError: (text: string) => string,
    error?: string,
  ) {
    this.#db = db;
    this.#path = path;
    this.#sanitizeError = sanitizeError;
    this.#error = error;
  }

  static open({ storeDir, sanitizeError }: OpenAppDbOptions): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    const path = storeDir === null ? null : join(storeDir, APP_DB_FILENAME);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path ?? ":memory:");
      // 会話ストアと同じ方針 (メモリ DB では無視される)
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      const instance = new AppDb(db, path, sanitize);
      const version = instance.#schemaVersion();
      // user_version が 0 = 未初期化 (新規ファイル・0 バイトの残骸・メモリ DB)。このときだけ seed する
      if (version === 0) instance.#recreate(true);
      // 古い版は加算的に移行する (定義を消さない)。未知の新しい版だけ従来どおり作り直す
      else if (version < APP_DB_SCHEMA_VERSION) instance.#migrate();
      else if (version > APP_DB_SCHEMA_VERSION) instance.#recreate(false);
      return instance;
    } catch (error) {
      try {
        // 失敗した接続を残さない (後始末の失敗で元の理由を隠さない)
        db?.close();
      } catch {
        // noop
      }
      console.error(`[u7agent] app db unavailable: ${sanitize(messageFor(error))}`);
      return new AppDb(null, path, sanitize, sanitize(messageFor(error)));
    }
  }

  /** パス解決の失敗など、開く前に DB を使えないと分かっている状態 */
  static unavailable({
    storeDir,
    error,
    sanitizeError,
  }: {
    storeDir: string | null;
    error: string;
    sanitizeError?: (text: string) => string;
  }): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    return new AppDb(null, storeDir === null ? null : join(storeDir, APP_DB_FILENAME), sanitize, sanitize(error));
  }

  status(): AppDbStatus {
    if (!this.#db) return { path: this.#path, ok: false, error: this.#error ?? "unknown error" };
    // 壊れた保存値は別テーブルの成功で消さない (health が失敗を示し続ける)。解消はその行の修正か保存し直し
    const [storedValueError] = this.#storedValueErrors.values();
    const error = storedValueError ?? this.#error;
    return error ? { path: this.#path, ok: false, error } : { path: this.#path, ok: true };
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /** 途中で失敗したら部分適用を残さない。呼び出し側の例外はそのまま伝える */
  transaction<T>(fn: () => T): T {
    this.#query((db) => db.exec("BEGIN"));
    try {
      const result = fn();
      this.#query((db) => db.exec("COMMIT"));
      return result;
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // rollback の失敗で元の例外を隠さない (接続が壊れている場合は次のクエリで 503 になる)
      }
      throw error;
    }
  }

  /** 入口ガードが失敗状態から戻れるかを確かめる軽い読み取り (成功したら #error が消える) */
  probe(): boolean {
    return this.#query((db) => Boolean(db.prepare("SELECT 1").get()));
  }

  #handle(): DatabaseSync {
    if (!this.#db) throw httpError(503, `アプリデータ（SQLite）を利用できません: ${this.#error ?? "unknown error"}`);
    return this.#db;
  }

  /**
   * 稼働中の失敗も 503 に寄せる (成功したら解除する)。理由は health にも出る。
   * `storedValueKey` を渡した読取は「壊れた保存値」として扱い、別テーブルの成功では消さない。
   */
  #query<T>(fn: (db: DatabaseSync) => T, storedValueKey?: string): T {
    const db = this.#handle();
    try {
      const result = fn(db);
      if (storedValueKey) this.#storedValueErrors.delete(storedValueKey);
      this.#error = undefined;
      return result;
    } catch (error) {
      const message = this.#sanitizeError(messageFor(error));
      this.#error = message;
      if (storedValueKey) this.#storedValueErrors.set(storedValueKey, message);
      console.error(`[u7agent] app db query failed: ${message}`);
      throw httpError(503, `アプリデータ（SQLite）を利用できません: ${message}`);
    }
  }

  /**
   * provider メモ専用のクエリ入口。メモはマスカーへ登録しないため、トリガーの RAISE などで例外文言に
   * 値が写っても、#query がログ / #error へ渡す前に値を含まない固定文言へ置き換える。
   */
  #memoQuery<T>(fn: (db: DatabaseSync) => T): T {
    return this.#query((db) => {
      try {
        return fn(db);
      } catch {
        throw new Error(PROVIDER_MEMO_QUERY_FAILED);
      }
    });
  }

  /**
   * 暗号文を読む / 書くクエリ専用の入口。`#query` がログ・health・503 へ値を渡す前に、
   * 操作の分類だけを表す固定文言へ置き換える。SQLite のトリガーなどで `hex(NEW.ciphertext)` を
   * 例外へ反射させても、値はここより外へ出ない。
   */
  #secretQuery<T>(fn: (db: DatabaseSync) => T): T {
    return this.#query((db) => {
      try {
        return fn(db);
      } catch {
        throw new Error(APP_SECRET_QUERY_FAILED);
      }
    });
  }

  #schemaVersion(): number {
    const row = this.#handle().prepare("PRAGMA user_version").get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  /**
   * 加算移行の列追加。SQLite に `ADD COLUMN IF NOT EXISTS` は無く PRAGMA はパラメータ化できないため、
   * テーブル名・列名・定義はコード側の定数だけを渡す。存在確認は毎回 PRAGMA を引く
   * (結果をキャッシュすると、同じ列名を別テーブルへ足すときに壊れる)。
   */
  #addColumnIfMissing(table: string, column: string, definition: string): void {
    this.#query((db) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (columns.some((row) => row.name === column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });
  }

  /**
   * v14 -> v15 の改名。`CREATE TABLE IF NOT EXISTS` を先に走らせると空テーブルができて RENAME が
   * 失敗するため、CREATE より先に通す。両方あるときは移行先を正として触らない（行は移行先だけが持つ）。
   */
  #renameTableIfNeeded(from: string, to: string): void {
    this.#query((db) => {
      if (!this.#tableExists(from) || this.#tableExists(to)) return;
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
    });
  }

  /**
   * 列の削除。存在確認は `#addColumnIfMissing` と同じ理由で毎回 PRAGMA を引く
   * (`DROP COLUMN IF EXISTS` は SQLite に無く、呼び出し元の版判定だけに任せると再実行で壊れる)。
   */
  #dropColumnIfExists(table: string, column: string): void {
    this.#query((db) => {
      if (!this.#tableExists(table)) return;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!columns.some((row) => row.name === column)) return;
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    });
  }

  /** テーブルの削除。`IF EXISTS` に頼らず sqlite_master で確かめる (再実行しても同じ結果になる) */
  #dropTableIfExists(table: string): void {
    if (this.#tableExists(table)) this.#query((db) => db.exec(`DROP TABLE ${table}`));
  }

  /** 列の改名。存在確認は `#addColumnIfMissing` と同じ理由で毎回 PRAGMA を引く */
  #renameColumnIfNeeded(table: string, from: string, to: string): void {
    this.#query((db) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      const names = columns.map((row) => row.name);
      if (!names.includes(from) || names.includes(to)) return;
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    });
  }

  /** 列の存在確認。SQLite に `IF EXISTS` が無いため、テーブル名と同じくコード側の定数だけを渡す */
  #hasColumn(db: DatabaseSync, table: string, column: string): boolean {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return false;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return columns.some((row) => row.name === column);
  }

  /** テーブル名は sqlite_master で確かめる (PRAGMA と違い、値はバインドで渡せる) */
  #tableExists(table: string): boolean {
    return Boolean(
      this.#query((db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)),
    );
  }

  /**
   * v30 -> v31 の移行。既存の平文 APIキー / Webhook URL は移行せずに破棄し、暗号文の列だけを持つ形へ揃える。
   * 判定は user_version ではなく **平文列の有無** で行う: 後続のスキーマ変更で移行が再実行されても、
   * 暗号化済みの値を消さない。改ざん・破損した値の断片が例外文言へ写っても外へ出さないよう、
   * 値に触る文はすべて #secretQuery の内側で実行する。
   */
  #migrateAppSecrets(): void {
    this.#secretQuery((db) => {
      // キー専用テーブルは平文列があるときだけ作り直す (行はすべて破棄する)
      if (this.#hasColumn(db, "provider_credentials", "apiKey")) {
        db.exec("DROP TABLE provider_credentials");
        db.exec(PROVIDER_CREDENTIALS_TABLE);
      }
      if (this.#hasColumn(db, "web_search_provider_keys", "apiKey")) {
        db.exec("DROP TABLE web_search_provider_keys");
        db.exec(WEB_SEARCH_PROVIDER_KEYS_TABLE);
      }
      // content_settings は設定行と非キーの列を残し、キーだけを暗号文の列へ移す
      if (this.#hasColumn(db, "content_settings", "apiKey")) {
        db.exec("ALTER TABLE content_settings ADD COLUMN ciphertext BLOB");
        db.exec("ALTER TABLE content_settings ADD COLUMN nonce BLOB");
        db.exec("ALTER TABLE content_settings ADD COLUMN keyVersion INTEGER");
        // 旧キーと一致・包含する音声の値は、キー破棄後も応答へ出さないため NULL にする
        db.exec(
          `UPDATE content_settings
              SET speechModel = CASE WHEN instr(speechModel, apiKey) > 0 THEN NULL ELSE speechModel END,
                  speechVoice = CASE WHEN instr(speechVoice, apiKey) > 0 THEN NULL ELSE speechVoice END
            WHERE apiKey IS NOT NULL AND apiKey <> ''`,
        );
        db.exec("ALTER TABLE content_settings DROP COLUMN apiKey");
      }
      // notification_settings も設定行と非 Webhook の列を残し、URL だけを暗号文の列へ移す
      if (this.#hasColumn(db, "notification_settings", "webhookUrl")) {
        db.exec("ALTER TABLE notification_settings ADD COLUMN webhookCiphertext BLOB");
        db.exec("ALTER TABLE notification_settings ADD COLUMN webhookNonce BLOB");
        db.exec("ALTER TABLE notification_settings ADD COLUMN webhookKeyVersion INTEGER");
        db.exec("ALTER TABLE notification_settings DROP COLUMN webhookUrl");
      }
    });
  }

  /** DROP → CREATE → user_version → (未初期化なら) seed を 1 トランザクションで行う */
  #recreate(seed: boolean): void {
    this.#query((db) => db.exec("BEGIN"));
    try {
      this.#query((db) => db.exec(DROP_TABLES));
      this.#query((db) => db.exec(CREATE_TABLES));
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      if (seed) this.#seed();
      this.#query((db) => db.exec("COMMIT"));
      // 既存 DB の作り直しはデータが消える経路なので警告として出す
      if (seed) console.log(`[u7agent] app db created (schema ${APP_DB_SCHEMA_VERSION})`);
      else console.error(`[u7agent] app db recreated without seed (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }

  #seed(): void {
    for (const agent of SEED_AGENTS) this.saveAgent(agent);
  }

  /**
   * 古い版からの移行。足りないテーブルと列を足し、その後に撤去対象だけを消す。
   * 改名 (v14 -> v15) だけが例外で、CREATE TABLE IF NOT EXISTS より先に RENAME を通す。
   * 削除 (v22 -> v23 の `skills` / `agents.skillIds`) は**既存の加算更新を通した後**に行い、
   * user_version の更新まで同じトランザクションに入れる (途中で失敗したら 1 つも残さない)。
   * スキル定義はファイルへ移行せず、退避・専用バックアップテーブルも作らない (docs/persistence.md)。
   */
  #migrate(): void {
    this.#query((db) => db.exec("BEGIN"));
    try {
      this.#query((db) => db.exec(NOTIFICATION_SETTINGS_TABLE));
      this.#query((db) => db.exec(ARCHIVE_SETTINGS_TABLE));
      this.#query((db) => db.exec(PROVIDER_CREDENTIALS_TABLE));
      this.#query((db) => db.exec(MODEL_SETTINGS_TABLE));
      this.#query((db) => db.exec(PROVIDER_MEMOS_TABLE));
      // 改名は CREATE より先。順序を逆にすると v14 の DB で RENAME が失敗し、DB を使えないまま起動する
      this.#renameTableIfNeeded("image_settings", "content_settings");
      this.#renameColumnIfNeeded("content_settings", "model", "imageModel");
      this.#query((db) => db.exec(CONTENT_SETTINGS_TABLE));
      this.#query((db) => db.exec(IMAGE_CATALOG_TABLE));
      this.#query((db) => db.exec(SPEECH_CATALOG_TABLE));
      this.#query((db) => db.exec(SERVE_COMMANDS_TABLE));
      this.#query((db) => db.exec(WEB_SEARCH_SETTINGS_TABLE));
      this.#query((db) => db.exec(WEB_SEARCH_PROVIDER_KEYS_TABLE));
      this.#query((db) => db.exec(TITLE_SUMMARY_SETTINGS_TABLE));
      this.#query((db) => db.exec(SECRETS_TABLE));
      this.#query((db) => db.exec(SHARED_CONTENTS_TABLE));
      this.#query((db) => db.exec(CLOUDFLARE_SETTINGS_TABLE));
      this.#query((db) => db.exec(SHARED_CONTENT_SETTINGS_TABLE));
      this.#query((db) => db.exec(SPACES_TABLE));
      // 列追加は CREATE TABLE IF NOT EXISTS の後 (既存テーブルでは CREATE が何もしないため)。DDL も
      // トランザクション対象なので、途中失敗で列だけが残らない
      this.#addColumnIfMissing("provider_credentials", "updatedAt", "INTEGER");
      // v12 以前の web_search_settings は id と enabled だけ。既存行は既定 (exa) で埋める
      this.#addColumnIfMissing("web_search_settings", "provider", "TEXT NOT NULL DEFAULT 'exa'");
      // v28 以前の title_summary_settings に無い Effort。既存行は NULL = 未指定として読む
      this.#addColumnIfMissing("title_summary_settings", "thinkingLevel", "TEXT");
      // v15 以前の content_settings に無い音声の 2 列。既存行は NULL = 既定へのフォールバック
      this.#addColumnIfMissing("content_settings", "speechModel", "TEXT");
      this.#addColumnIfMissing("content_settings", "speechVoice", "TEXT");
      // v25 以前に無い有効 / 無効。既存行は ON で埋める (キーがあるのに止まって見えないように)
      this.#addColumnIfMissing("content_settings", "enabled", "INTEGER NOT NULL DEFAULT 1");
      // v16 以前の agents に無い列。NULL = 未指定 (全可視) として読む。`#migrate()` は agents を
      // 作らないため、テーブルを持たない壊れた DB では列追加を飛ばす (ALTER で起動できなくしない)
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "commonSkillNames", "TEXT");
      // v17 以前に無い列 (組み込みスキルの許可リスト)。既存行は NULL = 全部 ON として読む
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "builtinSkillNames", "TEXT");
      // v18 以前に無い列 (ツールの許可リスト)。既存行は NULL = 未指定 (全部 ON) として読む
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "toolNames", "TEXT");
      // v29 以前に無い列 (自然文での発火)。既存行は NULL = 既定 (発火する) として読む
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "allowNaturalInvocation", "INTEGER");
      // v20 以前に無い列 (表示順)。既存行は NULL のままで、listAgents の rowid タイブレークが
      // そのまま作成順になる (移行で既存行を書き換えない)
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "sortOrder", "INTEGER");
      // v21 以前に無い列 (表示順)。agents と同じく既存行は NULL のままで、listSpaces の rowid
      // タイブレークがそのまま作成順になる
      this.#addColumnIfMissing("spaces", "sortOrder", "INTEGER");
      // v27 以前の共有物に無い列 (公開元の種類)。既存行は配下ディレクトリの公開として埋める
      this.#addColumnIfMissing("shared_contents", "sourceKind", "TEXT NOT NULL DEFAULT 'directory'");
      // v19 以前に無い列 (質問通知)。既存行は既定 (ON) で埋める
      this.#addColumnIfMissing("notification_settings", "askUser", "INTEGER NOT NULL DEFAULT 1");
      // v30 -> v31: 平文の APIキー / Webhook URL を落とし、暗号文の列だけを持つ形へ移す
      this.#migrateAppSecrets();
      // v22 -> v23: DB カタログの撤去。加算更新を通した後にだけ限定して消す
      this.#dropTableIfExists("skills");
      this.#dropColumnIfExists("agents", "skillIds");
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      this.#query((db) => db.exec("COMMIT"));
      console.log(`[u7agent] app db migrated (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }

  // --- notification settings (1 行だけ) ---

  getNotificationSettings(): NotificationSettingsRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM notification_settings WHERE id = 1").get() as Row | undefined,
    );
    return row ? notificationSettingsOf(row) : undefined;
  }

  /** Webhook URL は暗号文だけを書く。平文の列は持たない (値は呼び出し側が暗号化して渡す) */
  saveNotificationSettings(settings: NotificationSettingsRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO notification_settings
             (id, enabled, askUser, webhookCiphertext, webhookNonce, webhookKeyVersion, baseUrl, mention, lastResult)
           VALUES (1, ?, ?, ?, ?, ?, ?, 'none', ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, askUser = excluded.askUser,
             webhookCiphertext = excluded.webhookCiphertext, webhookNonce = excluded.webhookNonce,
             webhookKeyVersion = excluded.webhookKeyVersion, baseUrl = excluded.baseUrl, mention = 'none',
             lastResult = excluded.lastResult`,
        )
        .run(
          settings.enabled ? 1 : 0,
          settings.askUser ? 1 : 0,
          settings.webhook?.ciphertext ?? null,
          settings.webhook?.nonce ?? null,
          settings.webhook?.keyVersion ?? null,
          settings.baseUrl,
          settings.lastResult ? JSON.stringify(settings.lastResult) : null,
        ),
    );
  }

  // --- archive settings (1 行だけ。行が無い = 未設定) ---

  readArchiveExcludeNames(): string[] | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM archive_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      const names = jsonArrayColumn<string>("archive_settings", "excludeNames", row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、他の列と同じく 503 にする
      if (!names) throw new Error("archive_settings.excludeNames is not a JSON array");
      return names;
    }, "archive_settings");
  }

  saveArchiveExcludeNames(names: readonly string[]): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO archive_settings (id, excludeNames) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET excludeNames = excluded.excludeNames`,
        )
        .run(JSON.stringify(names)),
    );
  }

  /** 行を消して未設定へ戻す (既定名を保存し直すと、以後の既定の更新に追随しなくなる) */
  resetArchiveExcludeNames(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM archive_settings WHERE id = 1").run().changes > 0);
  }

  // --- shared content settings (共有の除外名。1 行だけ。行が無い = 未設定) ---

  readSharedContentExcludeNames(): string[] | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM shared_content_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      const names = jsonArrayColumn<string>("shared_content_settings", "excludeNames", row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、archive_settings と同じく 503 にする
      if (!names) throw new Error("shared_content_settings.excludeNames is not a JSON array");
      return names;
    }, "shared_content_settings");
  }

  saveSharedContentExcludeNames(names: readonly string[]): void {
    this.#query((db) =>
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
    return this.#query((db) => db.prepare("DELETE FROM shared_content_settings WHERE id = 1").run().changes > 0);
  }

  // --- provider credentials (GUI から登録したプロバイダー API キー) ---

  listProviderCredentials(): ProviderCredentialRow[] {
    return this.#secretQuery((db) =>
      (db.prepare("SELECT * FROM provider_credentials ORDER BY rowid").all() as Row[]).map(providerCredentialOf),
    );
  }

  getProviderCredential(provider: string): ProviderCredentialRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM provider_credentials WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerCredentialOf(row) : undefined;
  }

  /**
   * 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定し、
   * ここが成功して返れば行は永続化されている (呼び出し側の not_stored 判定の根拠)。
   * 値は暗号化済みの保存形だけを受け取り、`updatedAt` (epoch ms) は呼び出し側が渡す。
   */
  saveProviderCredential(provider: string, secret: StoredAppSecret, updatedAt: number): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO provider_credentials (provider, ciphertext, nonce, keyVersion, updatedAt)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion, updatedAt = excluded.updatedAt`,
        )
        .run(provider, secret.ciphertext, secret.nonce, secret.keyVersion, updatedAt),
    );
  }

  /** 復号せずに行を消す (master key が無くても削除できる) */
  deleteProviderCredential(provider: string): boolean {
    return this.#secretQuery(
      (db) => db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider).changes > 0,
    );
  }

  // --- provider memos (provider に紐づく人間用メモ。行が無い = 未設定) ---

  listProviderMemos(): ProviderMemoRow[] {
    return this.#memoQuery((db) =>
      (db.prepare("SELECT * FROM provider_memos ORDER BY rowid").all() as Row[])
        .map(providerMemoOf)
        .filter((row): row is ProviderMemoRow => row !== undefined),
    );
  }

  getProviderMemo(provider: string): ProviderMemoRow | undefined {
    const row = this.#memoQuery(
      (db) => db.prepare("SELECT * FROM provider_memos WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerMemoOf(row) : undefined;
  }

  /** 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定する */
  saveProviderMemo(provider: string, memo: string): void {
    this.#memoQuery((db) =>
      db
        .prepare(
          `INSERT INTO provider_memos (provider, memo) VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET memo = excluded.memo`,
        )
        .run(provider, memo),
    );
  }

  deleteProviderMemo(provider: string): boolean {
    return this.#memoQuery(
      (db) => db.prepare("DELETE FROM provider_memos WHERE provider = ?").run(provider).changes > 0,
    );
  }

  // --- model settings (1 行だけ。行が無い = 未設定) ---

  /** 行が無ければ undefined。壊れた JSON は黙って未設定へ落とさず 503 にする */
  readModelSettings(): ModelSettingsRow | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM model_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      // 行がある以上 allowedModels は JSON 配列か NULL のはず。壊れた値を制限なしと読み違えない
      const parsed =
        row.allowedModels === null
          ? null
          : jsonArrayColumn<ModelRef>("model_settings", "allowedModels", row.allowedModels);
      if (row.allowedModels !== null && !parsed) throw new Error("model_settings.allowedModels is not a JSON array");
      return {
        allowedModels: parsed && parsed.length > 0 ? parsed : null,
        defaultModel: optionalText(row.defaultModel) ?? null,
      };
    }, "model_settings");
  }

  /** 空配列は制限なしへ正規化する。両方 null になったら行を消して未設定へ戻す */
  saveModelSettings(settings: ModelSettingsRow): void {
    const allowedModels = settings.allowedModels && settings.allowedModels.length > 0 ? settings.allowedModels : null;
    const defaultModel = settings.defaultModel || null;
    if (!allowedModels && !defaultModel) {
      this.resetModelSettings();
      return;
    }
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO model_settings (id, allowedModels, defaultModel) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET allowedModels = excluded.allowedModels, defaultModel = excluded.defaultModel`,
        )
        .run(allowedModels ? JSON.stringify(allowedModels) : null, defaultModel),
    );
  }

  /** 行を消して未設定へ戻す (保存値が残っていないことを応答で確かめる導線) */
  resetModelSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM model_settings WHERE id = 1").run().changes > 0);
  }

  // --- content settings (1 行だけ。行が無い = 未設定) ---

  /** 行が無ければ undefined。空文字へ手編集された行も未設定として読む (キーは暗号文だけを返す) */
  readContentSettings(): ContentSettingsRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM content_settings WHERE id = 1").get() as Row | undefined,
    );
    return row ? contentSettingsOf(row) : undefined;
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。単一ステートメントなので自動コミットで確定する */
  saveContentSettings(settings: ContentSettingsRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO content_settings
             (id, provider, imageModel, speechModel, speechVoice, enabled, ciphertext, nonce, keyVersion)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, imageModel = excluded.imageModel,
             speechModel = excluded.speechModel, speechVoice = excluded.speechVoice, enabled = excluded.enabled,
             ciphertext = excluded.ciphertext, nonce = excluded.nonce, keyVersion = excluded.keyVersion`,
        )
        .run(
          settings.provider,
          settings.imageModel,
          settings.speechModel,
          settings.speechVoice,
          settings.enabled ? 1 : 0,
          settings.ciphertext,
          settings.nonce,
          settings.keyVersion,
        ),
    );
  }

  /** 行を消して未設定へ戻す (キー削除は provider / imageModel も含めて行ごと消す)。復号は不要 */
  deleteContentSettings(): boolean {
    return this.#secretQuery((db) => db.prepare("DELETE FROM content_settings WHERE id = 1").run().changes > 0);
  }

  // --- cloudflare settings (1 行だけ。行が無い = 未登録) ---

  /**
   * 行が無ければ undefined。NOT NULL の列が欠けた行は、未登録と読み違えて上書きしないよう例外にする
   * (サービスが 503 へ変換し、DELETE だけは通す)。
   */
  readCloudflareSettings(): CloudflareSettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM cloudflare_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    const accountId = optionalText(row.accountId);
    const ciphertext = optionalBlob(row.ciphertext);
    const nonce = optionalBlob(row.nonce);
    const keyVersion = optionalNumber(row.keyVersion);
    if (!accountId || !ciphertext || !nonce || keyVersion === null || !Number.isInteger(keyVersion)) {
      throw new Error("cloudflare_settings row is incomplete");
    }
    return { accountId, ciphertext, nonce, keyVersion, updatedAt: Number(row.updatedAt) };
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。単一ステートメントなので自動コミットで確定する */
  saveCloudflareSettings(settings: CloudflareSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO cloudflare_settings (id, accountId, ciphertext, nonce, keyVersion, updatedAt)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET accountId = excluded.accountId, ciphertext = excluded.ciphertext,
             nonce = excluded.nonce, keyVersion = excluded.keyVersion, updatedAt = excluded.updatedAt`,
        )
        .run(settings.accountId, settings.ciphertext, settings.nonce, settings.keyVersion, settings.updatedAt),
    );
  }

  /** 行を消して未登録へ戻す。資格情報を消しても shared_contents の providerAccount は変えない */
  deleteCloudflareSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM cloudflare_settings WHERE id = 1").run().changes > 0);
  }

  /**
   * 別のアカウントで公開した共有物が残っているか。未受付 (providerAccount が NULL) の行は
   * まだ何も公開していないため対象外にする。
   */
  hasSharedContentsForOtherAccount(accountId: string): boolean {
    const row = this.#query(
      (db) =>
        db
          .prepare(
            "SELECT 1 AS found FROM shared_contents WHERE providerAccount IS NOT NULL AND providerAccount <> ? LIMIT 1",
          )
          .get(accountId) as Row | undefined,
    );
    return row !== undefined;
  }

  // --- shared contents (1 行 1 共有物) ---

  insertSharedContent(row: SharedContentRow): void {
    this.#query((db) =>
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
    this.#query((db) =>
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
    this.#query((db) => db.prepare("UPDATE shared_contents SET name = ? WHERE id = ?").run(name, id));
  }

  getSharedContent(id: string): SharedContentRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM shared_contents WHERE id = ?").get(id) as Row | undefined,
    );
    return row ? sharedContentOf(row) : undefined;
  }

  listSharedContents(sessionId?: string): SharedContentRow[] {
    return this.#query((db) =>
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
    return this.#query((db) =>
      (
        db.prepare("SELECT * FROM shared_contents WHERE status = 'publishing' ORDER BY createdAt ASC").all() as Row[]
      ).map(sharedContentOf),
    );
  }

  /** 行を消す。provider 側の削除が成功したあとにだけ呼ぶ */
  deleteSharedContent(id: string): void {
    this.#query((db) => db.prepare("DELETE FROM shared_contents WHERE id = ?").run(id));
  }

  // --- web search settings (1 行だけ。行が無い = 既定（有効 / exa）) ---

  /** 行が無ければ undefined = 既定（有効 / exa）。0 / 1 以外へ手編集された行も 1 として読む */
  readWebSearchSettings(): WebSearchSettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM web_search_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    return {
      enabled: Number(row.enabled) !== 0,
      provider: typeof row.provider === "string" ? row.provider : "",
    };
  }

  /** 保存は id = 1 の upsert。単一ステートメントなので自動コミットで確定する */
  saveWebSearchSettings(settings: WebSearchSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO web_search_settings (id, enabled, provider) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider`,
        )
        .run(settings.enabled ? 1 : 0, settings.provider),
    );
  }

  // --- title summary settings (1 行だけ。行が無い = 既定 = Off / モデル未選択) ---

  /** 行が無ければ undefined = 既定。空白だけの定義も既定として読む */
  readTitleSummarySettings(): TitleSummarySettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM title_summary_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    return {
      enabled: Number(row.enabled) !== 0,
      model: typeof row.model === "string" && row.model !== "" ? row.model : null,
      thinkingLevel: typeof row.thinkingLevel === "string" && row.thinkingLevel !== "" ? row.thinkingLevel : null,
      definition: typeof row.definition === "string" ? row.definition : "",
    };
  }

  /** 保存は id = 1 の upsert (web_search_settings と同じ形) */
  saveTitleSummarySettings(settings: TitleSummarySettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO title_summary_settings (id, enabled, model, thinkingLevel, definition) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, model = excluded.model,
             thinkingLevel = excluded.thinkingLevel, definition = excluded.definition`,
        )
        .run(settings.enabled ? 1 : 0, settings.model, settings.thinkingLevel, settings.definition),
    );
  }

  // --- web search provider keys (1 行 1 provider。行が無い = キー未設定) ---
  /** 行が無ければ undefined。値は暗号文だけで、復号はサービス側が行う */
  readWebSearchProviderKey(provider: string): StoredAppSecret | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM web_search_provider_keys WHERE provider = ?").get(provider) as Row | undefined,
    );
    if (!row) return undefined;
    const secret = storedAppSecretOf(row, "web_search_provider_keys");
    if (!secret) throw new Error("web_search_provider_keys row is incomplete");
    return secret;
  }

  /** 登録と上書きで同じ (provider 主キーの upsert)。値は暗号化済みの保存形だけを受け取る */
  saveWebSearchProviderKey(provider: string, secret: StoredAppSecret): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO web_search_provider_keys (provider, ciphertext, nonce, keyVersion) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion`,
        )
        .run(provider, secret.ciphertext, secret.nonce, secret.keyVersion),
    );
  }

  /** 行を消して未設定へ戻す。未設定でも false を返すだけで失敗にはしない (復号不要) */
  deleteWebSearchProviderKey(provider: string): boolean {
    return this.#secretQuery(
      (db) => db.prepare("DELETE FROM web_search_provider_keys WHERE provider = ?").run(provider).changes > 0,
    );
  }

  // --- image catalog (live カタログのキャッシュ 1 行) ---

  /** 行が無い / 形が崩れているときは undefined（未取得として SDK カタログへ落とす。health の失敗にはしない） */
  readImageCatalog(): ImageCatalogRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM image_catalog WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const models = imageCatalogModelsOf(row.models);
    const fetchedAt = Number(row.fetchedAt);
    if (!models || !Number.isFinite(fetchedAt)) return undefined;
    return { fetchedAt, models };
  }

  /** 取得成功時の上書き (id = 1 の upsert)。キャッシュなので、失敗しても呼び出し側は続行する */
  saveImageCatalog(row: ImageCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO image_catalog (id, fetchedAt, models) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, models = excluded.models`,
        )
        .run(row.fetchedAt, JSON.stringify(row.models)),
    );
  }

  // --- speech catalog (live カタログのキャッシュ 1 行) ---

  /** 行が無い / 形が崩れているときは undefined（未取得として同梱の既定カタログへ落とす。health の失敗にはしない） */
  readSpeechCatalog(): SpeechCatalogRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM speech_catalog WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const models = speechCatalogModelsOf(row.models);
    const fetchedAt = Number(row.fetchedAt);
    if (!models || !Number.isFinite(fetchedAt)) return undefined;
    return { fetchedAt, models };
  }

  /** 取得成功時の上書き (id = 1 の upsert)。キャッシュなので、失敗しても呼び出し側は続行する */
  saveSpeechCatalog(row: SpeechCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO speech_catalog (id, fetchedAt, models) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, models = excluded.models`,
        )
        .run(row.fetchedAt, JSON.stringify(row.models)),
    );
  }

  // --- spaces ---

  listSpaces(): Space[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM spaces ORDER BY sortOrder, rowid").all() as Row[]).map((row) => ({
        id: text(row.id),
        name: text(row.name),
        createdAt: Number(row.createdAt),
      })),
    );
  }

  /** 追加は末尾 (MAX + 1)。削除で詰めないため、並びは追加順に安定する */
  insertSpace(space: Space): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO spaces (id, name, createdAt, sortOrder)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM spaces))`,
        )
        .run(space.id, space.name, space.createdAt),
    );
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。
   * 採用する id の絞り込みは SpaceStore 側が行う (docs/api.md#スペース)。
   */
  reorderSpaces(ids: readonly string[]): void {
    this.transaction(() => {
      this.#query((db) => {
        const update = db.prepare("UPDATE spaces SET sortOrder = ? WHERE id = ?");
        ids.forEach((id, index) => update.run(index + 1, id));
      });
    });
  }

  /**
   * スペースの行と、その根を cwd に持つ行 (serve_commands / secrets) を 1 トランザクションで消す。
   * 前方一致は LIKE ではなく substr で行う (`%` / `_` を含む cwd で別の行を消さない)。戻り値は
   * `spaces` 行を消せたか (= commit point)。
   */
  deleteSpace(id: string): boolean {
    const dir = `${spaceDirRel(id)}/`;
    return this.transaction(() => {
      this.#query((db) => db.prepare("DELETE FROM serve_commands WHERE substr(cwd, 1, length(?)) = ?").run(dir, dir));
      this.#query((db) => db.prepare("DELETE FROM secrets WHERE substr(cwd, 1, length(?)) = ?").run(dir, dir));
      return this.#query((db) => db.prepare("DELETE FROM spaces WHERE id = ?").run(id).changes > 0);
    });
  }

  // --- projects ---

  listProjects(): Project[] {
    return this.#query((db) => (db.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]).map(projectOf));
  }

  getProject(id: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  findProjectByCwd(cwd: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE cwd = ?").get(cwd) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  insertProject(project: Project): void {
    this.#query((db) =>
      db
        .prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)")
        .run(project.id, project.name, project.cwd, project.createdAt),
    );
  }

  deleteProject(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0);
  }

  // --- agents ---

  /** 表示順 (sortOrder 昇順)。移行前の行は NULL なので、同じ NULL 同士は rowid = 作成順で並ぶ */
  listAgents(): AgentDef[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM agents ORDER BY sortOrder, rowid").all() as Row[]).map(agentOf),
    );
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。
   * 採用する id の絞り込みはカタログ側が行う (docs/api-catalog.md)。
   */
  reorderAgents(ids: readonly string[]): void {
    this.transaction(() => {
      this.#query((db) => {
        const update = db.prepare("UPDATE agents SET sortOrder = ? WHERE id = ?");
        ids.forEach((id, index) => update.run(index + 1, id));
      });
    });
  }

  getAgent(id: string): AgentDef | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined);
    return row ? agentOf(row) : undefined;
  }

  /**
   * 作成と更新で同じ (id が主キー)。**sortOrder は挿入のときだけ振る** (更新で `DO UPDATE SET` へ
   * 入れると、名前やアイコンの保存だけで位置が動く)。
   */
  saveAgent(agent: AgentDef): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO agents (id, name, description, systemPrompt, icon, model, thinkingLevel, suggestions, commonSkillNames, builtinSkillNames, toolNames, allowNaturalInvocation, sortOrder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM agents))
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
             systemPrompt = excluded.systemPrompt, icon = excluded.icon, model = excluded.model,
             thinkingLevel = excluded.thinkingLevel, suggestions = excluded.suggestions,
             commonSkillNames = excluded.commonSkillNames, builtinSkillNames = excluded.builtinSkillNames,
             toolNames = excluded.toolNames, allowNaturalInvocation = excluded.allowNaturalInvocation`,
        )
        .run(
          agent.id,
          agent.name,
          agent.description,
          agent.systemPrompt,
          agent.icon ?? null,
          agent.model ? JSON.stringify(agent.model) : null,
          agent.thinkingLevel ?? null,
          agent.suggestions ? JSON.stringify(agent.suggestions) : null,
          // 未指定は NULL、`[]` は "[]" (undefined と [] を混同しない)
          agent.commonSkillNames === undefined ? null : JSON.stringify(agent.commonSkillNames),
          agent.builtinSkillNames === undefined ? null : JSON.stringify(agent.builtinSkillNames),
          agent.toolNames === undefined ? null : JSON.stringify(agent.toolNames),
          // false だけ 0 を書き、true / 未指定は NULL (既定) へ寄せる
          agent.allowNaturalInvocation === false ? 0 : null,
        ),
    );
  }

  deleteAgent(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0);
  }

  // --- serve (サービスの起動実績) ---

  /** 作成順ではなく更新順。UI とエージェントが直近の実績を引きやすい */
  listServeCommands(): ServeCommandRow[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM serve_commands ORDER BY updatedAt").all() as Row[]).map(serveCommandOf),
    );
  }

  getServeCommand(cwd: string): ServeCommandRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM serve_commands WHERE cwd = ?").get(cwd) as Row | undefined,
    );
    return row ? serveCommandOf(row) : undefined;
  }

  /** 成功した起動だけを記録する (失敗したコマンドで以前の成功を上書きしない) */
  saveServeCommand(row: ServeCommandRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO serve_commands (cwd, command, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(cwd) DO UPDATE SET command = excluded.command, updatedAt = excluded.updatedAt`,
        )
        .run(row.cwd, row.command, row.updatedAt),
    );
  }

  // --- secrets (作業フォルダ単位の環境変数) ---

  /** 表示順 (sortOrder 昇順、同じなら名前順)。`serve_commands` と同じく cwd がキー */
  listSecrets(cwd: string): SecretRow[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM secrets WHERE cwd = ? ORDER BY sortOrder ASC, name ASC").all(cwd) as Row[]).map(
        secretOf,
      ),
    );
  }

  getSecret(secretId: string): SecretRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM secrets WHERE secretId = ?").get(secretId) as Row | undefined,
    );
    return row ? secretOf(row) : undefined;
  }

  /** 同じ cwd 内の一意性判定 (UNIQUE(cwd, name) の事前確認。cwd が違えば同名を許す) */
  findSecretByName(cwd: string, name: string): SecretRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM secrets WHERE cwd = ? AND name = ?").get(cwd, name) as Row | undefined,
    );
    return row ? secretOf(row) : undefined;
  }

  /** 追加は MAX(sortOrder) + 1。削除で詰めないため、並びは追加順に安定する */
  nextSecretSortOrder(cwd: string): number {
    const row = this.#query(
      (db) => db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS next FROM secrets WHERE cwd = ?").get(cwd) as Row,
    );
    return Number(row.next);
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。cwd も条件に入れ、
   * 他会話の secret_id が混ざっても並びを動かさない。採用する id の絞り込みは `SecretService` が行う。
   */
  reorderSecrets(cwd: string, ids: readonly string[]): void {
    this.transaction(() => {
      this.#query((db) => {
        const update = db.prepare("UPDATE secrets SET sortOrder = ? WHERE secretId = ? AND cwd = ?");
        ids.forEach((id, index) => update.run(index + 1, id, cwd));
      });
    });
  }

  /** 値は必ずバインドして渡す (SQL 文字列へ埋め込まない)。単一ステートメントなので自動コミットで確定する */
  insertSecret(row: SecretRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO secrets (secretId, cwd, name, kind, plaintext, ciphertext, nonce, keyVersion, sortOrder, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.secretId,
          row.cwd,
          row.name,
          row.kind,
          row.plaintext,
          row.ciphertext,
          row.nonce,
          row.keyVersion,
          row.sortOrder,
          row.createdAt,
          row.updatedAt,
        ),
    );
  }

  /** 値の上書きのみ (名前・種別・並びは変えない)。使わない列は null にして種別の排他を保つ */
  updateSecretValue(
    secretId: string,
    patch: {
      plaintext: string | null;
      ciphertext: Uint8Array | null;
      nonce: Uint8Array | null;
      keyVersion: number | null;
      updatedAt: number;
    },
  ): void {
    this.#query((db) =>
      db
        .prepare(
          `UPDATE secrets SET plaintext = ?, ciphertext = ?, nonce = ?, keyVersion = ?, updatedAt = ? WHERE secretId = ?`,
        )
        .run(patch.plaintext, patch.ciphertext, patch.nonce, patch.keyVersion, patch.updatedAt, secretId),
    );
  }

  deleteSecret(secretId: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM secrets WHERE secretId = ?").run(secretId).changes > 0);
  }

  // --- 複数テーブルにまたがる更新 (部分適用を残さない) ---

  /**
   * cwd をキーにする行 (secrets / serve_commands) を移動先へ付け替える。移動先に同名の行があると
   * UNIQUE 制約で失敗するため、部分適用を残さないよう 1 トランザクションで行う。
   */
  moveCwd(from: string, to: string): void {
    this.transaction(() => {
      this.#query((db) => db.prepare("UPDATE serve_commands SET cwd = ? WHERE cwd = ?").run(to, from));
      this.#query((db) => db.prepare("UPDATE secrets SET cwd = ? WHERE cwd = ?").run(to, from));
    });
  }
}
