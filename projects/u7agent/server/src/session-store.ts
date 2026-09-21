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
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SESSION_DIR_REL, assertSessionId, isSessionId, sessionWorkdirRel } from "./app-paths";
import type { AgentPayloadInfo, ThinkingLevel } from "./schema";

// 配置 (appdir / スクラッチ / 添付) の正は app-paths。既存の import 先を保つため再輸出する
export { SESSION_DIR_REL, assertSessionId, sessionWorkdirRel };
export const SESSION_STORE_ENV = "PI_SESSION_STORE";
/** 部分書込みの再試行回数。超えたらエラーを記録して次の保存に委ねる */
const MAX_WRITE_ATTEMPTS = 3;

export interface PromptSnapshot {
  /** 作成時の agent プロファイル (appendSystemPrompt へ入れたもの) */
  agent: string;
  /** 作成時のスキルプロンプト (順序を保つ) */
  skills: string[];
}

export interface SessionMeta {
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

function parseMeta(value: unknown, id: string): SessionMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Partial<SessionMeta>;
  if (meta.version !== 1 || meta.id !== id || typeof meta.title !== "string") return undefined;
  if (typeof meta.createdAt !== "number" || typeof meta.lastUsedAt !== "number") return undefined;
  if (typeof meta.messageCount !== "number" || typeof meta.agentId !== "string") return undefined;
  if (!meta.agent || typeof meta.agent !== "object") return undefined;
  const prompt = meta.promptSnapshot;
  if (!prompt || typeof prompt.agent !== "string" || !Array.isArray(prompt.skills)) return undefined;
  return {
    version: 1,
    id,
    title: meta.title,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
    messageCount: meta.messageCount,
    agentId: meta.agentId,
    agent: meta.agent as AgentPayloadInfo,
    promptSnapshot: { agent: prompt.agent, skills: prompt.skills.filter((s): s is string => typeof s === "string") },
    ...(typeof meta.projectCwd === "string" ? { projectCwd: meta.projectCwd } : {}),
    ...(typeof meta.projectName === "string" ? { projectName: meta.projectName } : {}),
    ...(typeof meta.model === "string" ? { model: meta.model } : {}),
    ...(typeof meta.thinkingLevel === "string" ? { thinkingLevel: meta.thinkingLevel } : {}),
  };
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

/** 既知の entry type ごとの必須フィールド。SDK が書く形だけを受理する */
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
