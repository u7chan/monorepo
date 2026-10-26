/**
 * セッションの会話ストア (BFF 専用)。サンドボックスへマウントしない。
 * JSONL は pi SDK と同形式で、確定バイト位置を基準に追記し、部分書込みは ftruncate で復旧する。
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SESSION_DIR_REL, assertSessionId, isSessionId, sessionWorkdirRel } from "./app-paths";
import type { AgentPayloadInfo, ThinkingLevel } from "./schema";
import { isSpaceId } from "./spaces";

// 配置 (appdir / スクラッチ / 添付) の正は app-paths。既存の import 先を保つため再輸出する
export { SESSION_DIR_REL, assertSessionId, sessionWorkdirRel };
export const SESSION_STORE_ENV = "PI_SESSION_STORE";
/** 部分書込みの再試行回数。超えたらエラーを記録して次の保存に委ねる */
const MAX_WRITE_ATTEMPTS = 3;

export interface PromptSnapshot {
  /** 作成時の agent プロファイル (appendSystemPrompt へ入れたもの) */
  agent: string;
}

/**
 * 引き継ぎ 1 回分の記録。操作 ID は世代発行と同じ作法のランダム値で、同じ作業フォルダを共有する別の会話が
 * 同じミリ秒に引き継いでも衝突しないようにする (冪等化の鍵は操作 ID ではなくメモ本文のハッシュ)。
 */
export interface SessionHandoffRecord {
  operationId: string;
  at: number;
  /** HANDOFF.md を書いたか (OFF の引き継ぎでは false) */
  memo: boolean;
  /** 引き継ぎ後に最初に受理した送信で立てる (チップの表示条件) */
  consumed: boolean;
}

export interface SessionMeta {
  spaceId?: string;
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  agentId: string;
  agent: AgentPayloadInfo;
  promptSnapshot: PromptSnapshot;
  projectCwd?: string;
  projectName?: string;
  model?: string;
  thinkingLevel?: string;
  /** 完了を Discord へ送るか (既定 false)。v1 の meta には無いので optional のままにする */
  notify?: boolean;
  /** サイドバーに固定するか (既定 false)。既存 meta では欠落するので optional のままにする */
  pinned?: boolean;
  /** 引き継ぎの記録。旧 meta は欠落 = 引き継ぎなし */
  handoff?: SessionHandoffRecord;
  /**
   * 引き継ぎの確定後に残った履歴の削除 (片付け) が未完了か。true の間は会話を開けず、新しい引き継ぎも
   * 受け付けない。旧 meta は欠落 = 片付け不要。
   */
  handoffCleanup?: boolean;
  /**
   * タイトルの由来 (自動 / AI / 手動)。旧 meta は欠落しており、既存タイトルは手動として保護する
   * (session-title.ts の titleOriginOf)。
   */
  titleOrigin?: "auto" | "ai" | "manual";
  /** AI 要約の判定と試行 (1 会話 1 回)。欠落 = 未判定で、既存の会話には遡及しない */
  titleAttempt?: {
    runId: string;
    at: number;
    state: "pending" | "done" | "failed" | "skipped";
    model?: string;
    thinkingLevel?: string;
    generation?: number;
    inputTokens?: number;
    outputTokens?: number;
    costTotal?: number;
  };
}

/** 引き継ぎごとの操作 ID。セッション ID と同じ 8 hex 文字 */
export function generateHandoffOperationId(): string {
  return randomBytes(4).toString("hex");
}

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export type ParsedSessionFile =
  | { kind: "empty" }
  | { kind: "ok"; header: SessionHeader; entries: SessionEntryLike[]; completeBytes: number; needsSeparator: boolean }
  | { kind: "damaged"; reason: string };

/** SDK の SessionEntry を BFF が読む分だけの緩い形 (未知フィールドはそのまま保持する) */
export type SessionEntryLike = Record<string, unknown> & {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
};

/** ストアが使えない (設定ミス) ことを表す。セッション作成は 503 で拒否する */
export class SessionStoreConfigError extends Error {}
/** JSONL が壊れていて開けないことを表す。原本は変更しない */
export class SessionDamagedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * store root を決める。既定は `<agentDir>/u7agent/sessions`。
 * ワークスペース root の中は、サンドボックスとストアを共有してしまう構成になるため拒否する。
 */
export function resolveSessionStoreDir({
  rootCwd,
  env = process.env,
}: {
  rootCwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const configured = env[SESSION_STORE_ENV]?.trim();
  const dir = configured ? resolve(configured) : join(getAgentDir(), "u7agent", "sessions");
  const root = resolve(rootCwd);
  const rel = relative(root, dir);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (rel === "" || !escapes) {
    throw new SessionStoreConfigError(
      `${SESSION_STORE_ENV} はワークスペースの外を指定してください (サンドボックスと会話ログを共有しないため): ${dir}`,
    );
  }
  return dir;
}

export async function prepareSessionStore(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export function sessionDirPath(storeDir: string, id: string): string {
  assertSessionId(id);
  return join(storeDir, id);
}

export function sessionMetaPath(id: string, storeDir: string): string {
  return join(sessionDirPath(storeDir, id), "meta.json");
}

export function sessionJsonlPath(id: string, storeDir: string): string {
  return join(sessionDirPath(storeDir, id), "session.jsonl");
}

/** 10 hex 文字。既存フォルダと衝突したら作り直す (外部ライブラリは使わない) */
export function generateSessionId(storeDir: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(5).toString("hex");
    if (!existsSync(sessionDirPath(storeDir, id))) return id;
  }
  throw new Error("セッション ID を生成できませんでした");
}

export async function listSessionIds(storeDir: string): Promise<string[]> {
  const entries = await readdir(storeDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isSessionId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * meta の agent を保持対象のフィールドだけから組み直す。旧 meta の `skillIds` / `skills` は
 * ここで落とし、会話を開き直して再保存しても復活させない (docs/api-sessions.md)。
 */
function parseAgentPayload(value: unknown): AgentPayloadInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const agent = value as Partial<AgentPayloadInfo>;
  if (typeof agent.id !== "string" || typeof agent.name !== "string") return undefined;
  const names = (list: unknown): string[] | undefined =>
    Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : undefined;
  const commonSkillNames = names(agent.commonSkillNames);
  const builtinSkillNames = names(agent.builtinSkillNames);
  const toolNames = names(agent.toolNames);
  return {
    id: agent.id,
    name: agent.name,
    description: typeof agent.description === "string" ? agent.description : "",
    ...(commonSkillNames ? { commonSkillNames } : {}),
    ...(builtinSkillNames ? { builtinSkillNames } : {}),
    ...(toolNames ? { toolNames } : {}),
  };
}

function parseMeta(value: unknown, id: string): SessionMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Partial<SessionMeta>;
  if (meta.spaceId !== undefined && !isSpaceId(meta.spaceId)) return undefined;
  if (meta.spaceId !== undefined && meta.spaceId !== "default" && meta.projectCwd !== undefined) return undefined;
  if (meta.version !== 1 || meta.id !== id || typeof meta.title !== "string") return undefined;
  if (typeof meta.createdAt !== "number" || typeof meta.lastUsedAt !== "number") return undefined;
  if (typeof meta.messageCount !== "number" || typeof meta.agentId !== "string") return undefined;
  const agent = parseAgentPayload(meta.agent);
  if (!agent) return undefined;
  const prompt = meta.promptSnapshot as Partial<PromptSnapshot> | undefined;
  // カタログ撤去後の新形式は `skills` を持たない。旧 meta の `skills` はここで落とし、
  // 開き直して再保存してもカタログ専用キーを書き戻さない (docs/api-sessions.md)
  if (!prompt || typeof prompt.agent !== "string") return undefined;
  const handoff = parseHandoff(meta.handoff);
  const titleAttempt = parseTitleAttempt(meta.titleAttempt);
  return {
    version: 1,
    ...(meta.spaceId !== undefined ? { spaceId: meta.spaceId } : {}),
    id,
    title: meta.title,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
    messageCount: meta.messageCount,
    agentId: meta.agentId,
    agent,
    promptSnapshot: { agent: prompt.agent },
    ...(typeof meta.projectCwd === "string" ? { projectCwd: meta.projectCwd } : {}),
    ...(typeof meta.projectName === "string" ? { projectName: meta.projectName } : {}),
    ...(typeof meta.model === "string" ? { model: meta.model } : {}),
    ...(typeof meta.thinkingLevel === "string" ? { thinkingLevel: meta.thinkingLevel } : {}),
    // boolean 以外は無視する (手で書き換えられた meta で通知が勝手に有効にならないように)
    ...(typeof meta.notify === "boolean" ? { notify: meta.notify } : {}),
    // 欠落や不正値は未固定として扱い、既存データの読み込みを妨げない。
    ...(typeof meta.pinned === "boolean" ? { pinned: meta.pinned } : {}),
    // 引き継ぎの記録と片付けの印も同じ方針 (欠落 = 引き継ぎなし / 片付け不要)。
    // 不正な記録は落とし、読み込みそのものは妨げない
    ...(handoff ? { handoff } : {}),
    ...(meta.handoffCleanup === true ? { handoffCleanup: true } : {}),
    // タイトルの由来と AI 要約の試行。欠落・不正値は未保存として落とし、読み込みは妨げない。
    // ここで落とすと再起動後に「判定済み」が消え、1 会話 1 試行を守れない
    ...(meta.titleOrigin === "auto" || meta.titleOrigin === "ai" || meta.titleOrigin === "manual"
      ? { titleOrigin: meta.titleOrigin }
      : {}),
    ...(titleAttempt ? { titleAttempt } : {}),
  };
}

/** 試行の保存値。必須項目が欠けた記録は落とす (欠落 = 未判定として安全側に倒す) */
function parseTitleAttempt(value: unknown): SessionMeta["titleAttempt"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const attempt = value as Record<string, unknown>;
  const state = attempt.state;
  if (typeof attempt.runId !== "string" || attempt.runId === "") return undefined;
  if (typeof attempt.at !== "number" || !Number.isFinite(attempt.at)) return undefined;
  if (state !== "pending" && state !== "done" && state !== "failed" && state !== "skipped") return undefined;
  return {
    runId: attempt.runId,
    at: attempt.at,
    state,
    ...(typeof attempt.model === "string" ? { model: attempt.model } : {}),
    ...(typeof attempt.thinkingLevel === "string" ? { thinkingLevel: attempt.thinkingLevel } : {}),
    ...(typeof attempt.generation === "number" ? { generation: attempt.generation } : {}),
    ...(typeof attempt.inputTokens === "number" ? { inputTokens: attempt.inputTokens } : {}),
    ...(typeof attempt.outputTokens === "number" ? { outputTokens: attempt.outputTokens } : {}),
    ...(typeof attempt.costTotal === "number" ? { costTotal: attempt.costTotal } : {}),
  };
}

function parseHandoff(value: unknown): SessionHandoffRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SessionHandoffRecord>;
  if (typeof record.operationId !== "string" || record.operationId === "") return undefined;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined;
  if (typeof record.memo !== "boolean" || typeof record.consumed !== "boolean") return undefined;
  return { operationId: record.operationId, at: record.at, memo: record.memo, consumed: record.consumed };
}

/** 読めない meta は「壊れたセッション」として undefined を返す (一覧から除外する) */
export async function readSessionMeta(storeDir: string, id: string): Promise<SessionMeta | undefined> {
  try {
    const text = await readFile(sessionMetaPath(id, storeDir), "utf8");
    return parseMeta(JSON.parse(text), id);
  } catch {
    return undefined;
  }
}

/** 一時ファイル + rename で原子的に書く (部分的な meta を読ませない) */
export async function writeSessionMeta(storeDir: string, meta: SessionMeta): Promise<void> {
  const dir = sessionDirPath(storeDir, meta.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "meta.json");
  const temp = join(dir, `.meta-${randomBytes(4).toString("hex")}.json`);
  await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

/** 新規作成時の header。timestamp は meta.createdAt を使い、復元しても作成時刻を保つ */
export function sessionHeaderOf(meta: Pick<SessionMeta, "id" | "createdAt">, cwd: string): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: meta.id,
    timestamp: new Date(meta.createdAt).toISOString(),
    cwd,
  };
}

export function serializeSession(header: SessionHeader, entries: SessionEntryLike[]): string {
  return [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/** 受理済みだが user entry として保存されていない送信 (古い→新しい) */
export interface UnsentSend {
  /** 受付ごとに振る送信ID。再送でも変えない */
  sendId: string;
  /** 実行へ割り当て済みなら実行ID。手動圧縮待ちなど未割当の送信では省略する */
  runId?: string;
  /** モデルへ渡す本文そのもの (再送に使う。payload へ出すときはマスクする) */
  text: string;
  at: number;
}

/** JSONL の user entry に写した送信IDと実行ID。実行時の対応表は再起動で消えるため保存する */
export interface EntrySendIds {
  sendId: string;
  runId?: string;
}

/**
 * BFF 専用の未送信記録。受理済みでまだ user entry になっていない送信を残し、再起動後に
 * 「未送信」として見せる。entry と送信の対応は JSONL の entry 自身へ写す (SEND_ID_FIELD /
 * RUN_ID_FIELD) ため、このファイルの書込みだけ失敗しても対応は失われない。
 */
export interface SessionSends {
  unsent: UnsentSend[];
}

/** user message entry へ写す送信ID / 実行ID のフィールド名 (SDK は未知フィールドをそのまま保持する) */
export const SEND_ID_FIELD = "u7agentSendId";
export const RUN_ID_FIELD = "u7agentRunId";
/** assistant message entry へ写す応答IDのフィールド名 (同じ応答の delta / 履歴 / ツールを対応付ける) */
export const ASSISTANT_ID_FIELD = "u7agentAssistantId";

export function sessionSendsPath(id: string, storeDir: string): string {
  return join(sessionDirPath(storeDir, id), "sends.json");
}

export function emptySessionSends(): SessionSends {
  return { unsent: [] };
}

/** 壊れた記録は空へ縮退する (補助データなので復元を止めない) */
export function readSessionSends(storeDir: string, id: string): SessionSends {
  try {
    return parseSessionSends(JSON.parse(readFileSync(sessionSendsPath(id, storeDir), "utf8")));
  } catch {
    return emptySessionSends();
  }
}

/**
 * 旧記録 (`runId` だけ) は「1送信=1実行」として同じ値を送信IDと実行IDへ補完する。IDの無い
 * 記録は本文一致で対応を捏造せず落とす。
 */
function parseSessionSends(value: unknown): SessionSends {
  if (!isRecord(value)) return emptySessionSends();
  const unsent: UnsentSend[] = [];
  if (Array.isArray(value.unsent)) {
    for (const item of value.unsent) {
      if (!isRecord(item)) continue;
      if (typeof item.text !== "string" || typeof item.at !== "number") continue;
      const sendId = typeof item.sendId === "string" && item.sendId !== "" ? item.sendId : undefined;
      const runId = typeof item.runId === "string" && item.runId !== "" ? item.runId : undefined;
      if (sendId === undefined && runId === undefined) continue;
      unsent.push({
        // 旧記録は run id を送信IDとして読む (再送・破棄の対象を指定できるようにする)
        sendId: sendId ?? (runId as string),
        ...(runId === undefined ? {} : { runId }),
        text: item.text,
        at: item.at,
      });
    }
  }
  return { unsent };
}

/**
 * 一時ファイル + rename で原子的に書く。postMessage は同期で 202 を返すため、受理の記録も同期で
 * 書く (受理直後に落ちても「未送信」の表示が消えない)。
 */
export function writeSessionSends(storeDir: string, id: string, sends: SessionSends): void {
  const dir = sessionDirPath(storeDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.sends-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(temp, `${JSON.stringify(sends)}\n`, { mode: 0o600 });
  renameSync(temp, join(dir, "sends.json"));
}

/**
 * JSONL の user message entry に写した送信IDと実行ID (entry id -> 対応) を集める。対応の正はここで、
 * sends.json の書込みだけ失敗しても再起動後に対応を失わない。entry の存在は JSONL が証明する。
 * 旧保存データ (`u7agentRunId` だけ) は同じ値を送信IDにも補完する。
 */
export function entrySendsFromJsonl(entries: SessionEntryLike[]): Map<string, EntrySendIds> {
  const sends = new Map<string, EntrySendIds>();
  for (const entry of entries) {
    if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") continue;
    const message = entry.message as { role?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const sendId = entry[SEND_ID_FIELD];
    const runId = entry[RUN_ID_FIELD];
    const send = typeof sendId === "string" && sendId !== "" ? sendId : undefined;
    const run = typeof runId === "string" && runId !== "" ? runId : undefined;
    if (send === undefined && run === undefined) continue;
    sends.set(entry.id, { sendId: send ?? (run as string), ...(run === undefined ? {} : { runId: run }) });
  }
  return sends;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** SDK の content part (TextContent / ThinkingContent / ImageContent / ToolCall) の形を検証する */
function isValidContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  switch (part.type) {
    case "text":
      return typeof part.text === "string";
    case "thinking":
      return typeof part.thinking === "string";
    case "image":
      return typeof part.data === "string" && typeof part.mimeType === "string";
    case "toolCall":
      return (
        typeof part.id === "string" &&
        typeof part.name === "string" &&
        (isRecord(part.arguments) || typeof part.arguments === "string")
      );
    default:
      return false;
  }
}

/** message / custom_message の content。文字列か、既知の part だけの配列を許す */
function isStringOrTextParts(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every(isValidContentPart);
}

/** system message の section 差分。値は差し替え後の本文か、削除を表す null */
function isSystemSections(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((section) => section === null || typeof section === "string");
}

/**
 * system message の toolsAdded。SDK は要素をそのまま Map に入れ (getCurrentTools)、
 * 宣言を比べるときに parameters を JSON に通す (toToolDeclaration)。
 * parameters が無い宣言は、同じ名前の宣言が重なった時点で SyntaxError になる。
 */
function isToolDeclarations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (tool) =>
      isRecord(tool) &&
      typeof tool.name === "string" &&
      (tool.description === undefined || typeof tool.description === "string") &&
      isRecord(tool.parameters),
  );
}

/** system message の toolsRemoved。SDK は name だけで消す (toolsRemoved に宣言は入らない) */
function isToolRemovals(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((tool) => isRecord(tool) && typeof tool.name === "string");
}

/**
 * 既知の entry type ごとの必須フィールド。SDK が書く形だけを受理する。
 * SDK が entry type を足すと「未知 type = 破損」になり復元が 409 で詰まるため、SDK を上げたらここも見直す。
 */
function entryShapeError(type: string, entry: Record<string, unknown>): string | undefined {
  switch (type) {
    case "message": {
      const message = entry.message;
      if (!isRecord(message) || typeof message.role !== "string") return "message entry に message がありません";
      if (typeof message.timestamp !== "number") return "message entry に timestamp がありません";
      switch (message.role) {
        case "user":
        case "assistant":
        case "toolResult":
        case "custom":
          return isStringOrTextParts(message.content) ? undefined : `message.content が不正です: ${message.role}`;
        case "bashExecution":
          return typeof message.command === "string" && typeof message.output === "string"
            ? undefined
            : "bashExecution message が不正です";
        case "system":
          // SDK 0.87 は system prompt の section 差分と tool 構成の変更を system message として追記する
          // (本文は空で、差分は sections / toolsAdded / toolsRemoved に入る)
          return isStringOrTextParts(message.content) &&
            isSystemSections(message.sections) &&
            isToolDeclarations(message.toolsAdded) &&
            isToolRemovals(message.toolsRemoved)
            ? undefined
            : "system message が不正です";
        default:
          return `未知の message role です: ${message.role}`;
      }
    }
    case "thinking_level_change":
      return typeof entry.thinkingLevel === "string" ? undefined : "thinking_level_change entry が不正です";
    case "model_change":
      return typeof entry.provider === "string" && typeof entry.modelId === "string"
        ? undefined
        : "model_change entry が不正です";
    case "usage":
      // cache warming が追記する。使用量はプロバイダ実装ごとに項目が増えるため形は緩く見る
      return typeof entry.kind === "string" &&
        typeof entry.provider === "string" &&
        typeof entry.model === "string" &&
        isRecord(entry.usage)
        ? undefined
        : "usage entry が不正です";
    case "compaction":
      return typeof entry.summary === "string" &&
        typeof entry.firstKeptEntryId === "string" &&
        typeof entry.tokensBefore === "number"
        ? undefined
        : "compaction entry が不正です";
    case "branch_summary":
      return typeof entry.fromId === "string" && typeof entry.summary === "string"
        ? undefined
        : "branch_summary entry が不正です";
    case "custom":
      return typeof entry.customType === "string" ? undefined : "custom entry が不正です";
    case "custom_message":
      return typeof entry.customType === "string" && isStringOrTextParts(entry.content)
        ? undefined
        : "custom_message entry が不正です";
    case "context_edit":
      // リトライ / overflow recovery が失敗した試行をモデル文脈から外すために追記する
      return typeof entry.targetId === "string" &&
        (entry.replacement === null || (isRecord(entry.replacement) && isStringOrTextParts(entry.replacement.content)))
        ? undefined
        : "context_edit entry が不正です";
    case "label":
      return typeof entry.targetId === "string" ? undefined : "label entry が不正です";
    case "session_info":
      return typeof entry.name === "string" || entry.name === undefined ? undefined : "session_info entry が不正です";
    default:
      return `未知の entry type です: ${type}`;
  }
}

/**
 * JSONL を検証して読む。SDK の親探索は循環を検出しないため、`parentId` が前方参照でないことと
 * id の一意性をここで確認する。回復するのは「改行が無く JSON として parse できない末尾」だけ。
 */
export function parseSessionFile(text: string, id: string): ParsedSessionFile {
  if (!text) return { kind: "empty" };

  // バイト位置をずらさないため、空行も 1 行として数える (確定位置は行の終端で数える)
  const lines: Array<{ text: string; end: number; terminated: boolean }> = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) {
      lines.push({ text: text.slice(offset), end: text.length, terminated: false });
      break;
    }
    lines.push({ text: text.slice(offset, newline), end: newline + 1, terminated: true });
    offset = newline + 1;
  }

  const parsed: Record<string, unknown>[] = [];
  let completeBytes = 0;
  let needsSeparator = false;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    if (line.text.trim() === "") return { kind: "damaged", reason: "空行があります" };
    let entry: unknown;
    try {
      entry = JSON.parse(line.text);
    } catch {
      // 改行で終わっていない末尾だけを書込み途絶として捨てる
      if (last && !line.terminated) break;
      return { kind: "damaged", reason: "entry の JSON を解析できません" };
    }
    if (!isRecord(entry)) {
      if (last && !line.terminated) return { kind: "damaged", reason: "末尾の entry がオブジェクトではありません" };
      return { kind: "damaged", reason: "entry がオブジェクトではありません" };
    }
    parsed.push(entry);
    // 位置はバイトで数える (日本語を含む JSONL では文字数とずれる)
    completeBytes += Buffer.byteLength(line.text, "utf8") + (line.terminated ? 1 : 0);
    needsSeparator = !line.terminated;
  }

  const header = parsed[0];
  if (!header || header.type !== "session") return { kind: "damaged", reason: "header がありません" };
  if (header.id !== id) return { kind: "damaged", reason: "header の id がフォルダ名と一致しません" };
  if (header.version !== CURRENT_SESSION_VERSION) {
    return { kind: "damaged", reason: `対応していない session version です: ${String(header.version)}` };
  }

  const ids = new Set<string>();
  const entries: SessionEntryLike[] = [];
  for (const entry of parsed.slice(1)) {
    const entryId = entry.id;
    const type = entry.type;
    if (typeof entryId !== "string" || typeof type !== "string" || typeof entry.timestamp !== "string") {
      return { kind: "damaged", reason: "entry の必須フィールドがありません" };
    }
    if (ids.has(entryId)) return { kind: "damaged", reason: `entry id が重複しています: ${entryId}` };
    const parentId = entry.parentId;
    if (parentId !== null && (typeof parentId !== "string" || !ids.has(parentId))) {
      return { kind: "damaged", reason: `parentId が前方参照です: ${String(parentId)}` };
    }
    const shapeError = entryShapeError(type, entry);
    if (shapeError) return { kind: "damaged", reason: shapeError };
    ids.add(entryId);
    entries.push(entry as SessionEntryLike);
  }

  return {
    kind: "ok",
    header: header as unknown as SessionHeader,
    entries,
    completeBytes,
    needsSeparator,
  };
}

export async function readSessionFile(
  storeDir: string,
  id: string,
): Promise<{ parsed: ParsedSessionFile; text: string }> {
  const text = await readFile(sessionJsonlPath(id, storeDir), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { parsed: parseSessionFile(text, id), text };
}

export async function removeSessionDir(storeDir: string, id: string): Promise<void> {
  await rm(sessionDirPath(storeDir, id), { recursive: true, force: true });
}

/**
 * 会話履歴 (session.jsonl / sends.json) だけを消し、meta.json は残す。スペースの引っ越しは
 * 履歴を破棄するが会話そのものは残すため、フォルダごと消す removeSessionDir は使わない。
 * 無いファイルは成功として扱う (削除の再実行を冪等にする)。
 */
export async function removeSessionHistory(storeDir: string, id: string): Promise<void> {
  const dir = sessionDirPath(storeDir, id);
  await rm(join(dir, "session.jsonl"), { force: true });
  await rm(join(dir, "sends.json"), { force: true });
}

/** 追記の低レベル書込み。テストから部分書込み (ENOSPC) を再現できるように差し替え可能にする */
export type WriteChunk = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

/**
 * JSONL の追記ライター。追記は確定バイト位置へ行い、部分書込みは ftruncate して復旧してから再試行する。
 * 追記で表現できないとき (初回・並びの変化) だけ temp + rename で全体を書き直す。
 */
export class SessionFileWriter {
  private committedBytes: number;
  private persistedCount: number;
  private lastPersistedId: string | null;
  private needsSeparator: boolean;
  /** 復旧にも失敗して追記を停止したときだけ true */
  private sealed = false;
  private lastError: string | undefined;
  private tail = Promise.resolve();

  constructor(
    private readonly storeDir: string,
    private readonly id: string,
    state: { completeBytes: number; entries: SessionEntryLike[]; needsSeparator?: boolean } = {
      completeBytes: 0,
      entries: [],
    },
    private readonly writeChunk: WriteChunk = writeSync,
  ) {
    this.committedBytes = state.completeBytes;
    this.persistedCount = state.entries.length;
    this.lastPersistedId =
      state.entries.length > 0 ? (state.entries[state.entries.length - 1].id as string | null) : null;
    this.needsSeparator = state.needsSeparator ?? false;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** 書込みを直列化する。失敗しても reject せず、writer の error に残す (in-memory の実行は止めない) */
  schedule(header: SessionHeader, entries: SessionEntryLike[]): Promise<void> {
    const run = () => this.write(header, entries);
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return this.tail;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private write(header: SessionHeader, entries: SessionEntryLike[]): void {
    if (this.sealed) return;
    const path = sessionJsonlPath(this.id, this.storeDir);
    // symlink は書かない (別プロセスに差し替えられた場合の防御)
    try {
      if (lstatSync(path).isSymbolicLink()) {
        this.lastError = `session.jsonl が symlink です: ${path}`;
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.lastError = `session.jsonl を確認できません: ${messageFor(error)}`;
        return;
      }
    }
    // 作成直後 (ファイルが無い) は header だけでも先に置く
    if (!existsSync(path)) {
      this.rewrite(path, header, entries);
      return;
    }
    const extendsPersisted =
      this.lastPersistedId === null
        ? this.persistedCount === 0
        : entries.length > this.persistedCount && entries[this.persistedCount - 1]?.id === this.lastPersistedId;
    if (!extendsPersisted) {
      this.rewrite(path, header, entries);
      return;
    }
    const delta = entries.slice(this.persistedCount);
    if (delta.length === 0 && !this.needsSeparator) return;
    const prefix = this.needsSeparator ? "\n" : "";
    const text = prefix + delta.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const buffer = Buffer.from(text, "utf8");
    const start = this.committedBytes;
    let fd: number;
    try {
      fd = openSync(path, "r+");
    } catch {
      // ファイルが消えている (手動削除など)。次の全体書直しで作る
      this.rewrite(path, header, entries);
      return;
    }
    try {
      // 途絶した末尾と前回の部分書込みを落としてから確定位置へ書く
      try {
        ftruncateSync(fd, start);
      } catch (error) {
        this.lastError = `追記位置に復旧できません: ${messageFor(error)}`;
        return;
      }
      let written = 0;
      let attempts = 0;
      for (;;) {
        let chunk: number;
        try {
          chunk = this.writeChunk(fd, buffer, written, buffer.length - written, start + written);
        } catch (error) {
          attempts += 1;
          if (!this.rollback(fd, start)) {
            this.sealed = true;
            this.lastError = `追記に失敗し、復旧できません: ${messageFor(error)}`;
            return;
          }
          written = 0;
          if (attempts > MAX_WRITE_ATTEMPTS) {
            this.lastError = `追記に失敗しました (再試行 ${MAX_WRITE_ATTEMPTS} 回): ${messageFor(error)}`;
            return;
          }
          continue;
        }
        if (chunk <= 0) {
          attempts += 1;
          if (attempts > MAX_WRITE_ATTEMPTS) {
            this.lastError = "追記が進みません";
            return;
          }
          continue;
        }
        written += chunk;
        if (written === buffer.length) break;
      }
    } finally {
      closeSync(fd);
    }
    this.lastError = undefined;
    this.committedBytes = start + buffer.length;
    this.persistedCount = entries.length;
    this.lastPersistedId = entries.length > 0 ? ((entries[entries.length - 1].id as string) ?? null) : null;
    this.needsSeparator = false;
  }

  private rollback(fd: number, start: number): boolean {
    try {
      ftruncateSync(fd, start);
      return true;
    } catch {
      return false;
    }
  }

  private rewrite(path: string, header: SessionHeader, entries: SessionEntryLike[]): void {
    const text = serializeSession(header, entries);
    const temp = join(dirname(path), `.session-${randomBytes(4).toString("hex")}.jsonl`);
    let fd: number;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fd = openSync(temp, "wx", 0o600);
    } catch (error) {
      this.lastError = `書き直しに失敗しました: ${messageFor(error)}`;
      return;
    }
    try {
      const buffer = Buffer.from(text, "utf8");
      let written = 0;
      let attempts = 0;
      while (written < buffer.length) {
        try {
          const chunk = this.writeChunk(fd, buffer, written, buffer.length - written, written);
          if (chunk <= 0) throw new Error("書き直しが進みません");
          written += chunk;
        } catch (error) {
          attempts += 1;
          if (attempts > MAX_WRITE_ATTEMPTS) throw error;
        }
      }
    } catch (error) {
      closeSync(fd);
      rmSync(temp, { force: true });
      this.lastError = `書き直しに失敗しました: ${messageFor(error)}`;
      return;
    }
    closeSync(fd);
    // 宛先が symlink なら上書きしない (別プロセスに差し替えられた場合の防御)
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("宛先が symlink です");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        rmSync(temp, { force: true });
        this.lastError = `書き直しに失敗しました: ${messageFor(error)}`;
        return;
      }
    }
    try {
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      this.lastError = `書き直しに失敗しました: ${messageFor(error)}`;
      return;
    }
    this.lastError = undefined;
    this.committedBytes = Buffer.byteLength(text, "utf8");
    this.persistedCount = entries.length;
    this.lastPersistedId = entries.length > 0 ? ((entries[entries.length - 1].id as string) ?? null) : null;
    this.needsSeparator = false;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** thinking level の保存値。SDK の型へ寄せるのは呼び出し側 */
export function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value as ThinkingLevel | undefined;
}
