/**
 * アプリデータ (`u7agent.db`) のテーブル定義と移行。接続・トランザクションの境界・エラーの扱い
 * (503 / 文言のマスク / 保存値エラー) は `AppDb` が持ち、ここは同じ接続を借りて DDL と移行の SQL だけを
 * 扱う (docs/persistence.md)。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { jsonArrayColumn, text, type Row } from "./db-values";
import { DEFAULT_GIT_IDENTITY } from "./git-identity";
import { AGENT_PROMPT_LIMIT, PROMPT_LABEL_MAX, PROMPT_TEXT_MAX } from "./schema";

/** テーブル定義を変えたら上げる。新規作成と加算移行はこの版へ揃え、未知の版は作り直す */
export const APP_DB_SCHEMA_VERSION = 49;

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
 * v31 -> v32 で足したテーブル。設定 → モデルで作ったカスタムプロバイダーを 1 行 1 provider で持つ。
 * 定義と APIキーの暗号文を同じ行に置き、**行が無い = 未登録** (削除は行ごと消す)。
 * モデルは 1 provider = 1 model の現行仕様に合わせて 3 列で持つ (JSON の配列にはしない)。
 * `provider_credentials` と同じくアプリ所有なので `DROP_TABLES` に入れるが、
 * 加算移行では他テーブルの行を消さずに `CREATE TABLE IF NOT EXISTS` だけで合流させる。
 */
const CUSTOM_PROVIDERS_TABLE = `
CREATE TABLE IF NOT EXISTS custom_providers (
  provider      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  baseUrl       TEXT NOT NULL,
  modelId       TEXT NOT NULL,
  contextWindow INTEGER NOT NULL,
  maxTokens     INTEGER NOT NULL,
  ciphertext    BLOB NOT NULL,
  nonce         BLOB NOT NULL,
  keyVersion    INTEGER NOT NULL
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
 * 画像の生成パラメータの既定は v43 -> v44 の列追加で、NULL = 既定なし（空 map とは区別して読む）。
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
  keyVersion  INTEGER,
  imageParams TEXT
);
`;

/**
 * v37 -> v38 で足したテーブル。設定 → コンテンツ生成の試行ジョブのメタデータ。
 * 行は履歴そのもので、時間ベースの自動削除はしない。`state` の終端値は不変で、`running` からしか
 * 終端へは進まない (docs/api-settings.md)。APIキーは列に持たず、`keyEpoch` だけを残す。
 * 成果物の実体は `<storeDir>/trials` に置き、この表には名前・大きさ・形式・寸法だけを持つ (v38 -> v39)。
 * 容量は `succeeded` かつ `artifactState = 'stored'` の `artifactBytes` を合計して出す (走査しない)。
 * 音声の入力スナップショットは `voice` / `instructions` / `speed` に持ち、同じ入力の再利用もこの 3 列で照合する
 * (v39 -> v40。画像の行は 3 列とも NULL)。
 * 生成元は `provider`（v41 -> v42。NULL の既存行は openrouter として読む。v1 の試行は openrouter だけ）。
 * **`DROP_TABLES` に入れない**: 古いビルドへ戻したとき (recreate) はこのテーブルを知らないので放置され、
 * 新ビルドへ戻すと migrate() の `CREATE TABLE IF NOT EXISTS` がそのまま合流させる。
 */
const CONTENT_TRIALS_TABLE = `
CREATE TABLE IF NOT EXISTS content_trials (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  voice          TEXT,
  instructions   TEXT,
  speed          REAL,
  imageParams    TEXT,
  state          TEXT NOT NULL,
  keyEpoch       INTEGER NOT NULL,
  artifactState  TEXT NOT NULL,
  charged        INTEGER NOT NULL DEFAULT 0,
  artifactPath   TEXT,
  artifactBytes  INTEGER,
  artifactFormat TEXT,
  artifactWidth  INTEGER,
  artifactHeight INTEGER,
  failureCode    TEXT,
  failureMessage TEXT,
  startedAt      INTEGER NOT NULL,
  finishedAt     INTEGER,
  durationMs     INTEGER,
  provider       TEXT
);
CREATE INDEX IF NOT EXISTS content_trials_started ON content_trials (startedAt);
`;

/**
 * v37 -> v38 で足したテーブル。コンテンツ生成のAPIキーの世代。`content_settings` の行はキー削除で
 * 消えるため、世代は消えない専用の 1 行に持つ（行が無い = 0 世代）。`content_trials` と同じく
 * `DROP_TABLES` に入れない（世代が戻ると、旧キーの実績が現在のキーの証拠に見えてしまう）。
 */
const CONTENT_KEY_EPOCH_TABLE = `
CREATE TABLE IF NOT EXISTS content_key_epoch (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL
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
 * v47 -> v48 で足したテーブル。コストマスタの接続先を 1 行だけ持ち、**行が無い = 未設定**。
 * `content_settings` に足さない理由は、キー削除が行ごと消すテーブルへ、キーと独立の運用設定を
 * 同居させないため。**`DROP_TABLES` に入れる**: 失ってはいけない値を持たず、戻すと未設定になるだけ。
 */
const CONTENT_COST_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS content_cost_settings (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL,
  url     TEXT NOT NULL
);
`;

/**
 * v47 -> v48 で足したテーブル。取得に成功した価格スナップショットを 1 行だけ残す
 * （`image_catalog` と同じ派生キャッシュ。docs/persistence.md）。取得失敗時は行を消さず前回値を使う。
 */
const CONTENT_COST_CATALOG_TABLE = `
CREATE TABLE IF NOT EXISTS content_cost_catalog (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  fetchedAt INTEGER NOT NULL,
  sourceUrl TEXT NOT NULL,
  version   INTEGER,
  models    TEXT NOT NULL
);
`;

/**
 * v40 -> v41 で足したテーブル。モデルごとの応答形式 (mp3 / pcm) の学習結果を 1 行 1 モデルで持つ。
 * **行が無い = 未学習** (mp3 から試す)。一覧 API が宣言しない形式を生成の 400 と応答から学ぶ派生データ
 * なので、読めない行は未学習として読み、health を落とさない (docs/speech-generation.md)。
 */
const SPEECH_FORMATS_TABLE = `
CREATE TABLE IF NOT EXISTS speech_formats (
  model     TEXT PRIMARY KEY,
  format    TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
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
 * 古いビルドへ戻したとき (recreate) はこのテーブルを知らないので放置され、新ビルドへ戻すと
 * migrate() の `CREATE TABLE IF NOT EXISTS` がそのまま合流させる。
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
 * **行が無い = 既定（無効 / exa）**。コンテンツ生成（`content_settings`）と並ぶツール公開の状態で、
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
 * v48 -> v49 で足したテーブル。設定 → 音声入力の OpenAI Platform のキーを 1 行だけ持ち、
 * **行が無い = キー未設定**（削除は行ごと消す）。コンテンツ生成の `content_settings` と同居させないのは、
 * キー削除や照合の規則（音声の値にキーを混ぜない等）へ無関係な制約を持ち込まないため。
 * **`DROP_TABLES` に入れない**: キーを失う経路を増やさない (`secrets` と同じ扱い)。古いビルドへ戻したときの
 * recreate はこのテーブルを知らないので放置され、新ビルドの migrate() が合流させる。
 */
const VOICE_INPUT_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS voice_input_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  keyVersion INTEGER NOT NULL
);
`;

/** v32 -> v33 で足したテーブル。応答 1 件分の実測を派生データとして持つ (docs/persistence.md) */
const ASSISTANT_METRICS_TABLE = `
CREATE TABLE IF NOT EXISTS assistant_metrics (
  session_id      TEXT NOT NULL,
  assistant_id    TEXT NOT NULL,
  at              INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  ttft_ms         INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_read      INTEGER,
  cache_write     INTEGER,
  reasoning_tokens INTEGER,
  cost_usd        REAL,
  stop_reason     TEXT,
  PRIMARY KEY (session_id, assistant_id)
);
CREATE INDEX IF NOT EXISTS assistant_metrics_model ON assistant_metrics (provider, model, at);
CREATE INDEX IF NOT EXISTS assistant_metrics_at ON assistant_metrics (at);
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
 * v44 -> v45 で足したテーブル。Git のグローバル identity を 1 行だけ持つ。
 * v45 -> v46 で初期 identity を入れ、行が無ければ未設定として読む (両方揃っているときだけ有効)。
 */
const GIT_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS git_settings (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  userName  TEXT NOT NULL,
  userEmail TEXT NOT NULL
);
`;

const SPACES_TABLE = `CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, sortOrder INTEGER
);`;

/**
 * v23 -> v24 で足したテーブル。Cloudflare へ公開した静的成果物を 1 行 1 共有物で持つ。
 *
 * **このテーブルは削除・リネームをしない加算移行の対象で、`DROP_TABLES` に入れない**: 行が消えると
 * Cloudflare 側に公開物が残ったまま追跡・停止・削除できなくなる。`secrets` と同じ理由で、古いビルドへ
 * 戻したとき (recreate) は放置され、新ビルドで `CREATE TABLE IF NOT EXISTS` が合流させる。
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
  lastError   TEXT,
  thumbnailUpdatedAt INTEGER,
  thumbnailWidth INTEGER,
  thumbnailHeight INTEGER,
  thumbnailBytes INTEGER
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
 * （`shared_contents` と同じ扱い。古いビルドへ戻したとき (recreate) は放置され、新ビルドで
 * `CREATE TABLE IF NOT EXISTS` が合流させる）。
 */
const SHARED_CONTENT_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS shared_content_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  excludeNames TEXT NOT NULL
);
`;

/**
 * v33 -> v34 で足した定型プロンプトのマスタ。`kind` は `builtin` / `custom` で、組み込み行は
 * 起動時に `builtin-catalog.ts` の定義へ同期される。本文とラベルには一意制約を付けない
 * (同じ本文の別マスタをまとめない)。`sortOrder` は自作の表示順で、組み込みは NULL のまま
 * 一覧の先頭へ固定する (v35 -> v36 の加算移行で足した)。
 */
const PROMPTS_TABLE = `CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom')),
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  sortOrder INTEGER
);`;

/**
 * v33 -> v34 で足したエージェントからマスタへの順序付き参照。`ON DELETE RESTRICT` で使用中の削除を
 * DB でも防ぎ、`ON DELETE CASCADE` でエージェント削除時は紐づけだけを消す（マスタは残す）。
 * 上限 (1..6) と重複禁止も DB 側の制約で守る。`INTEGER` 宣言だけでは SQLite が REAL (1.5) を
 * そのまま受けるため、型まで CHECK で縛る (位置は 1..6 の整数だけ)。
 */
const AGENT_PROMPTS_TABLE = `CREATE TABLE IF NOT EXISTS agent_prompts (
  agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  promptId TEXT NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 1 AND 6),
  PRIMARY KEY (agentId, promptId),
  UNIQUE (agentId, position)
);`;

/**
 * v41 -> v42 で足したテーブル。画像の生成元（openrouter / codex）を 1 行だけ持ち、**行が無い = 既定**。
 * `content_settings` の行と分ける理由は、OpenRouter キーの削除（行ごと消す）で Codex の選択まで
 * 消えないようにするため。**`DROP_TABLES` に入れる**: 失ってはいけない値を持たない設定の写しで、
 * 戻すと既定 (openrouter) へ戻るだけ。
 */
const IMAGE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS image_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  provider    TEXT NOT NULL,
  codexParams TEXT
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
  commonSkillNames TEXT,
  builtinSkillNames TEXT,
  toolNames TEXT,
  allowNaturalInvocationBuiltin INTEGER,
  allowNaturalInvocationFile INTEGER,
  sortOrder INTEGER
);
${PROMPTS_TABLE}
${AGENT_PROMPTS_TABLE}
${NOTIFICATION_SETTINGS_TABLE}
${ARCHIVE_SETTINGS_TABLE}
${PROVIDER_CREDENTIALS_TABLE}
${MODEL_SETTINGS_TABLE}
${PROVIDER_MEMOS_TABLE}
${CUSTOM_PROVIDERS_TABLE}
${CONTENT_SETTINGS_TABLE}
${IMAGE_SETTINGS_TABLE}
${CONTENT_KEY_EPOCH_TABLE}
${CONTENT_TRIALS_TABLE}
${IMAGE_CATALOG_TABLE}
${SPEECH_CATALOG_TABLE}
${CONTENT_COST_SETTINGS_TABLE}
${CONTENT_COST_CATALOG_TABLE}
${SPEECH_FORMATS_TABLE}
${SERVE_COMMANDS_TABLE}
${WEB_SEARCH_SETTINGS_TABLE}
${WEB_SEARCH_PROVIDER_KEYS_TABLE}
${VOICE_INPUT_SETTINGS_TABLE}
${TITLE_SUMMARY_SETTINGS_TABLE}
${GIT_SETTINGS_TABLE}
${SECRETS_TABLE}
${SHARED_CONTENTS_TABLE}
${CLOUDFLARE_SETTINGS_TABLE}
${SHARED_CONTENT_SETTINGS_TABLE}
${SPACES_TABLE}
${ASSISTANT_METRICS_TABLE}`;

/** アプリ所有のテーブルだけを落とす (同じ DB に足した別機能のテーブルを巻き込まない) */
const DROP_TABLES = `
DROP TABLE IF EXISTS agent_prompts;
DROP TABLE IF EXISTS prompts;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS archive_settings;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS model_settings;
DROP TABLE IF EXISTS provider_memos;
DROP TABLE IF EXISTS custom_providers;
DROP TABLE IF EXISTS content_settings;
DROP TABLE IF EXISTS image_settings;
DROP TABLE IF EXISTS image_catalog;
DROP TABLE IF EXISTS speech_catalog;
DROP TABLE IF EXISTS content_cost_settings;
DROP TABLE IF EXISTS content_cost_catalog;
DROP TABLE IF EXISTS speech_formats;
DROP TABLE IF EXISTS serve_commands;
DROP TABLE IF EXISTS web_search_settings;
DROP TABLE IF EXISTS web_search_provider_keys;
DROP TABLE IF EXISTS title_summary_settings;
DROP TABLE IF EXISTS git_settings;
DROP TABLE IF EXISTS assistant_metrics;
`;
// secrets / shared_contents / cloudflare_settings / shared_content_settings / voice_input_settings は意図的に含めない
// (docs/secrets.md / docs/static-sharing-design.md)。assistant_metrics は JSONL から引き直せる派生データなので
// 含める (行が消えても、再起動後の表示が SDK 記録値の概算へ戻るだけ)。speech_formats も同じ派生データで、
// 消えても形式違いの 400 が 1 往復増えるだけ。
// 列追加も migrate() にだけ足し、既存行を書き換える移行はしない。

/** 接続の入口。`AppDb` が持つ 1 本の接続・トランザクション・秘密値の境界を借りる */
export interface AppDbSchemaDb {
  query<T>(fn: (db: DatabaseSync) => T, storedValueKey?: string): T;
  /** 暗号文に触る文を、ログ・health・503 へ渡す前に固定文言へ置き換える境界 (`#migrateAppSecrets` 用) */
  secretQuery<T>(fn: (db: DatabaseSync) => T): T;
  transaction<T>(fn: () => T): T;
}

/**
 * テーブルの作成・加算移行・作り直しと、廃止した行の掃除。`AppDb.open()` だけが順序を決める。
 */
export class AppDbSchema {
  readonly #db: AppDbSchemaDb;

  constructor(db: AppDbSchemaDb) {
    this.#db = db;
  }

  /**
   * 加算移行の列追加。SQLite に `ADD COLUMN IF NOT EXISTS` は無く PRAGMA はパラメータ化できないため、
   * テーブル名・列名・定義はコード側の定数だけを渡す。存在確認は毎回 PRAGMA を引く
   * (結果をキャッシュすると、同じ列名を別テーブルへ足すときに壊れる)。
   */
  #addColumnIfMissing(table: string, column: string, definition: string): void {
    this.#db.query((db) => {
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
    this.#db.query((db) => {
      if (!this.#tableExists(from) || this.#tableExists(to)) return;
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
    });
  }

  /**
   * 列の削除。存在確認は `#addColumnIfMissing` と同じ理由で毎回 PRAGMA を引く
   * (`DROP COLUMN IF EXISTS` は SQLite に無く、呼び出し元の版判定だけに任せると再実行で壊れる)。
   */
  #dropColumnIfExists(table: string, column: string): void {
    this.#db.query((db) => {
      if (!this.#tableExists(table)) return;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!columns.some((row) => row.name === column)) return;
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    });
  }

  /** テーブルの削除。`IF EXISTS` に頼らず sqlite_master で確かめる (再実行しても同じ結果になる) */
  #dropTableIfExists(table: string): void {
    if (this.#tableExists(table)) this.#db.query((db) => db.exec(`DROP TABLE ${table}`));
  }

  /** 列の改名。存在確認は `#addColumnIfMissing` と同じ理由で毎回 PRAGMA を引く */
  #renameColumnIfNeeded(table: string, from: string, to: string): void {
    this.#db.query((db) => {
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
      this.#db.query((db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)),
    );
  }

  /**
   * v30 -> v31 の移行。既存の平文 APIキー / Webhook URL は移行せずに破棄し、暗号文の列だけを持つ形へ揃える。
   * 判定は user_version ではなく **平文列の有無** で行う: 後続のスキーマ変更で移行が再実行されても、
   * 暗号化済みの値を消さない。改ざん・破損した値の断片が例外文言へ写っても外へ出さないよう、
   * 値に触る文はすべて `secretQuery` の境界の内側で実行する。
   */
  #migrateAppSecrets(): void {
    this.#db.secretQuery((db) => {
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

  /**
   * v34 -> v35 の移行。旧定義の `agent_prompts` は `INTEGER` 宣言だけで REAL の位置を受け付けたため、
   * 整数型の CHECK を持つテーブルへ組み替える。行は保持し、範囲外の値が混ざっていたときだけ
   * 黙って捨てずに失敗させる (旧 API は整数しか書かないため、見つかれば手編集された行)。
   */
  #tightenAgentPrompts(): void {
    this.#db.query((db) => {
      if (!this.#tableExists("agent_prompts")) return;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get("agent_prompts") as
        | Row
        | undefined;
      // 整数型の検査が入った定義なら何もしない (新規作成・移行済みの DB)
      if (text(row?.sql).includes("typeof(position)")) return;
      db.exec("ALTER TABLE agent_prompts RENAME TO agent_prompts_legacy");
      db.exec(AGENT_PROMPTS_TABLE);
      db.exec(
        `INSERT INTO agent_prompts (agentId, promptId, position)
         SELECT agentId, promptId, position FROM agent_prompts_legacy
          WHERE typeof(position) = 'integer' AND position BETWEEN 1 AND 6
          ORDER BY agentId, position`,
      );
      const legacy = db.prepare("SELECT COUNT(*) AS count FROM agent_prompts_legacy").get() as Row;
      const kept = db.prepare("SELECT COUNT(*) AS count FROM agent_prompts").get() as Row;
      if (Number(legacy.count) !== Number(kept.count)) {
        throw new Error("agent_prompts has rows outside the allowed positions");
      }
      db.exec("DROP TABLE agent_prompts_legacy");
    });
  }

  /**
   * v33 -> v34 の移行。既存の `agents.suggestions` の各項目を独立した自作マスタと紐づけへ変換し、
   * 内容と表示順を保持する。同文でも既存項目同士・組み込みとは統合しない。変換後にだけ旧列を外し、
   * 不正な保存値は黙って捨てずに例外にしてトランザクションごと巻き戻す (既存の DB 障害の扱いに合流)。
   */
  #migrateAgentSuggestions(): void {
    this.#db.query((db) => {
      // 列の有無で判定する (後続の版で移行が再実行されても、変換済みのデータを二重に作らない)
      if (!this.#hasColumn(db, "agents", "suggestions")) return;
      // 古い版では sortOrder が無いため、作成順 (rowid) だけを頼りにする
      const rows = db.prepare("SELECT id, suggestions FROM agents ORDER BY rowid").all() as Row[];
      const insertPrompt = db.prepare("INSERT INTO prompts (id, kind, label, prompt) VALUES (?, 'custom', ?, ?)");
      const link = db.prepare("INSERT INTO agent_prompts (agentId, promptId, position) VALUES (?, ?, ?)");
      for (const row of rows) {
        const value = row.suggestions;
        if (value === null || value === undefined) continue;
        const items = jsonArrayColumn<unknown>("agents", "suggestions", value);
        if (!items) throw new Error("agents.suggestions is not a JSON array");
        if (items.length > AGENT_PROMPT_LIMIT) throw new Error("agents.suggestions has too many items");
        const agentId = text(row.id);
        items.forEach((item, index) => {
          const record = item as { label?: unknown; prompt?: unknown } | null;
          const label = typeof record?.label === "string" ? record.label : "";
          const prompt = typeof record?.prompt === "string" ? record.prompt : "";
          // 旧保存経路は空要素を落としていたため、ここに来る空値は壊れた行として扱う
          if (!label.trim() || !prompt.trim()) throw new Error("agents.suggestions has an invalid item");
          if (label.length > PROMPT_LABEL_MAX || prompt.length > PROMPT_TEXT_MAX) {
            throw new Error("agents.suggestions has an oversized item");
          }
          const id = `prompt-${randomUUID()}`;
          insertPrompt.run(id, label, prompt);
          link.run(agentId, id, index + 1);
        });
      }
      db.exec("ALTER TABLE agents DROP COLUMN suggestions");
    });
  }

  /**
   * v29 -> v30 で足した 1 本の自然文発火フラグを、スコープ別の 2 列へ移す (v36 -> v37)。
   * 移行元の値は「両方 OFF」の意図なので、`0` だけを両列の `0` にコピーし、旧列は同じトランザクションで落とす。
   * 古い版には旧列が無いので、無い場合は何もしない (全部既定 = ON になる)。
   */
  #migrateNaturalInvocationByScope(): void {
    this.#db.query((db) => {
      if (!this.#hasColumn(db, "agents", "allowNaturalInvocation")) return;
      // 移行元が 1 (理論上は書き込まない値) のときは既定の NULL に倒す (true を保存の形へ持ち込まない)
      db.exec(
        "UPDATE agents SET allowNaturalInvocationBuiltin = 0, allowNaturalInvocationFile = 0 WHERE allowNaturalInvocation = 0",
      );
      db.exec("ALTER TABLE agents DROP COLUMN allowNaturalInvocation");
    });
  }

  /** DROP → CREATE → user_version → (新規なら) 初期値を 1 トランザクションで行う */
  recreate(fresh: boolean): void {
    this.#db.query((db) => db.exec("BEGIN"));
    try {
      this.#db.query((db) => db.exec(DROP_TABLES));
      this.#db.query((db) => db.exec(CREATE_TABLES));
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#db.query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      if (fresh) this.#insertDefaultGitIdentity();
      this.#db.query((db) => db.exec("COMMIT"));
      // 既存 DB の作り直しはデータが消える経路なので警告として出す
      if (fresh) console.log(`[u7agent] app db created (schema ${APP_DB_SCHEMA_VERSION})`);
      else console.error(`[u7agent] app db recreated without defaults (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#db.query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }

  /** 初期 identity。行が既にある DB は上書きしない (利用者が消した行を再挿入しない) */
  #insertDefaultGitIdentity(): void {
    this.#db.query((db) =>
      db
        .prepare(
          `INSERT INTO git_settings (id, userName, userEmail)
           SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM git_settings WHERE id = 1)`,
        )
        .run(DEFAULT_GIT_IDENTITY.userName, DEFAULT_GIT_IDENTITY.userEmail),
    );
  }

  /**
   * アプリ同梱の組み込みプロンプトを廃止したため、旧版が残した行と、その参照を消す。
   * 新規 DB・移行後・再起動のどの経路でも通るよう `open()` から呼ぶ。
   */
  removeBuiltinPrompts(): void {
    this.#db.transaction(() => {
      this.#db.query((db) => {
        // 壊れた旧 DB は agents を持たないことがある。参照表が無ければ行も無いので、マスタだけ消す
        if (this.#tableExists("agents") && this.#tableExists("agent_prompts")) {
          db.exec("DELETE FROM agent_prompts WHERE promptId IN (SELECT id FROM prompts WHERE kind = 'builtin')");
        }
        db.exec("DELETE FROM prompts WHERE kind = 'builtin'");
      });
    });
  }

  /**
   * 古い版からの移行。足りないテーブルと列を足し、その後に撤去対象だけを消す。
   * 改名 (v14 -> v15) だけが例外で、CREATE TABLE IF NOT EXISTS より先に RENAME を通す。
   * 削除 (v22 -> v23 の `skills` / `agents.skillIds`) は**既存の加算更新を通した後**に行い、
   * user_version の更新まで同じトランザクションに入れる (途中で失敗したら 1 つも残さない)。
   * スキル定義はファイルへ移行せず、退避・専用バックアップテーブルも作らない (docs/persistence.md)。
   * `fromVersion` は「v46 未満からの移行か」の判定にだけ使い、他の加算はすべての古い版に同じく当てる。
   */
  migrate(fromVersion: number): void {
    this.#db.query((db) => db.exec("BEGIN"));
    try {
      this.#db.query((db) => db.exec(NOTIFICATION_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(ARCHIVE_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(PROVIDER_CREDENTIALS_TABLE));
      this.#db.query((db) => db.exec(MODEL_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(PROVIDER_MEMOS_TABLE));
      this.#db.query((db) => db.exec(CUSTOM_PROVIDERS_TABLE));
      // 改名は CREATE より先。順序を逆にすると v14 の DB で RENAME が失敗し、DB を使えないまま起動する
      this.#renameTableIfNeeded("image_settings", "content_settings");
      this.#renameColumnIfNeeded("content_settings", "model", "imageModel");
      this.#db.query((db) => db.exec(CONTENT_SETTINGS_TABLE));
      // v41 -> v42: 画像の生成元を持つ別テーブル（content_settings の行と分ける）
      this.#db.query((db) => db.exec(IMAGE_SETTINGS_TABLE));
      // v37 -> v38: 試行ジョブの履歴と、キー削除でも消えないキー世代
      this.#db.query((db) => db.exec(CONTENT_KEY_EPOCH_TABLE));
      this.#db.query((db) => db.exec(CONTENT_TRIALS_TABLE));
      // v41 -> v42: 試行の生成元。既存行は NULL で、読むときに openrouter へ寄せる
      this.#addColumnIfMissing("content_trials", "provider", "TEXT");
      // v38 -> v39: 試行の成果物のメタデータ。既存行は `charged = 0` / 成果物なしで読む
      this.#addColumnIfMissing("content_trials", "charged", "INTEGER NOT NULL DEFAULT 0");
      this.#addColumnIfMissing("content_trials", "artifactPath", "TEXT");
      this.#addColumnIfMissing("content_trials", "artifactBytes", "INTEGER");
      this.#addColumnIfMissing("content_trials", "artifactFormat", "TEXT");
      this.#addColumnIfMissing("content_trials", "artifactWidth", "INTEGER");
      this.#addColumnIfMissing("content_trials", "artifactHeight", "INTEGER");
      // v39 -> v40: 音声の試行の入力スナップショット（画像の行は NULL のまま）
      this.#addColumnIfMissing("content_trials", "voice", "TEXT");
      this.#addColumnIfMissing("content_trials", "instructions", "TEXT");
      this.#addColumnIfMissing("content_trials", "speed", "REAL");
      // v42 -> v43: 画像の試行の入力スナップショット。既存行は NULL（未指定）のまま読む
      this.#addColumnIfMissing("content_trials", "imageParams", "TEXT");
      this.#db.query((db) => db.exec(IMAGE_CATALOG_TABLE));
      this.#db.query((db) => db.exec(SPEECH_CATALOG_TABLE));
      // v47 -> v48: 任意のコストマスタの接続先と、取得に成功した価格スナップショット
      this.#db.query((db) => db.exec(CONTENT_COST_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(CONTENT_COST_CATALOG_TABLE));
      // v40 -> v41: 形式の学習結果。既存行を書き換えず、未学習 (行なし) から始まる
      this.#db.query((db) => db.exec(SPEECH_FORMATS_TABLE));
      this.#db.query((db) => db.exec(SERVE_COMMANDS_TABLE));
      this.#db.query((db) => db.exec(WEB_SEARCH_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(WEB_SEARCH_PROVIDER_KEYS_TABLE));
      // v48 -> v49: 音声入力のキー。行が無い = 未設定で、既存行は書き換えない
      this.#db.query((db) => db.exec(VOICE_INPUT_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(TITLE_SUMMARY_SETTINGS_TABLE));
      // v44 -> v45: Git のグローバル identity。v45 -> v46 で初期 identity を入れる
      this.#db.query((db) => db.exec(GIT_SETTINGS_TABLE));
      // 初期値は「行が無い」を未設定として読む v46 以降の意味を壊さないよう、新規 DB と v46 未満からの
      // 移行だけで入れる (v46 以降に DELETE した行を、後の版の移行で復活させない)
      if (fromVersion < 46) this.#insertDefaultGitIdentity();
      this.#db.query((db) => db.exec(SECRETS_TABLE));
      this.#db.query((db) => db.exec(SHARED_CONTENTS_TABLE));
      this.#db.query((db) => db.exec(CLOUDFLARE_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(SHARED_CONTENT_SETTINGS_TABLE));
      this.#db.query((db) => db.exec(SPACES_TABLE));
      this.#db.query((db) => db.exec(ASSISTANT_METRICS_TABLE));
      // v33 -> v34: 定型プロンプトのマスタと、エージェントからの参照
      this.#db.query((db) => db.exec(PROMPTS_TABLE));
      this.#db.query((db) => db.exec(AGENT_PROMPTS_TABLE));
      // v35 -> v36: 自作マスタの表示順。既存行は NULL のままで、listPrompts の rowid タイブレークが
      // そのまま作成順になる (移行で既存行を書き換えない)
      this.#addColumnIfMissing("prompts", "sortOrder", "INTEGER");
      // v34 -> v35: 位置を整数に限る CHECK が無い版のテーブルを作り直す
      this.#tightenAgentPrompts();
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
      // v43 -> v44: 画像の生成パラメータの既定（モデル id → 値の map）。既存行は NULL（既定なし）のまま読む
      this.#addColumnIfMissing("content_settings", "imageParams", "TEXT");
      // v16 以前の agents に無い列。NULL = 未指定 (全可視) として読む。`migrate()` は agents を
      // 作らないため、テーブルを持たない壊れた DB では列追加を飛ばす (ALTER で起動できなくしない)
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "commonSkillNames", "TEXT");
      // v17 以前に無い列 (組み込みスキルの許可リスト)。既存行は NULL = 全部 ON として読む
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "builtinSkillNames", "TEXT");
      // v18 以前に無い列 (ツールの許可リスト)。既存行は NULL = 未指定 (全部 ON) として読む
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "toolNames", "TEXT");
      // v36 -> v37: 自然文発火をスコープ別の 2 列へ分ける。旧列のコピーと drop は加算更新の後に行う
      if (this.#tableExists("agents")) {
        this.#addColumnIfMissing("agents", "allowNaturalInvocationBuiltin", "INTEGER");
        this.#addColumnIfMissing("agents", "allowNaturalInvocationFile", "INTEGER");
      }
      // v20 以前に無い列 (表示順)。既存行は NULL のままで、listAgents の rowid タイブレークが
      // そのまま作成順になる (移行で既存行を書き換えない)
      if (this.#tableExists("agents")) this.#addColumnIfMissing("agents", "sortOrder", "INTEGER");
      // v21 以前に無い列 (表示順)。agents と同じく既存行は NULL のままで、listSpaces の rowid
      // タイブレークがそのまま作成順になる
      this.#addColumnIfMissing("spaces", "sortOrder", "INTEGER");
      // v27 以前の共有物に無い列 (公開元の種類)。既存行は配下ディレクトリの公開として埋める
      this.#addColumnIfMissing("shared_contents", "sourceKind", "TEXT NOT NULL DEFAULT 'directory'");
      // v46 -> v47: サムネイルのメタ。既存行は 4 列とも NULL = 未設定として読む
      this.#addColumnIfMissing("shared_contents", "thumbnailUpdatedAt", "INTEGER");
      this.#addColumnIfMissing("shared_contents", "thumbnailWidth", "INTEGER");
      this.#addColumnIfMissing("shared_contents", "thumbnailHeight", "INTEGER");
      this.#addColumnIfMissing("shared_contents", "thumbnailBytes", "INTEGER");
      // v19 以前に無い列 (質問通知)。既存行は既定 (ON) で埋める
      this.#addColumnIfMissing("notification_settings", "askUser", "INTEGER NOT NULL DEFAULT 1");
      // v30 -> v31: 平文の APIキー / Webhook URL を落とし、暗号文の列だけを持つ形へ移す
      this.#migrateAppSecrets();
      // v22 -> v23: DB カタログの撤去。加算更新を通した後にだけ限定して消す
      this.#dropTableIfExists("skills");
      this.#dropColumnIfExists("agents", "skillIds");
      // v33 -> v34: 既存の定型プロンプトを変換してから旧列を外す。他の列追加が済んだ後に置く
      // (途中で失敗したら列も中身も版も残るので、開き直して再試行できる)
      this.#migrateAgentSuggestions();
      // v36 -> v37: 1 本の自然文発火フラグを 2 列へ移してから旧列を外す。他の列追加が済んだ後に置く
      // (途中で失敗したら旧列も値も残るので、開き直して再試行できる)
      this.#migrateNaturalInvocationByScope();
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#db.query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      this.#db.query((db) => db.exec("COMMIT"));
      console.log(`[u7agent] app db migrated (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#db.query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }
}
