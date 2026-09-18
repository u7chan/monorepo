/**
 * セッションの会話ストア (BFF 専用)。レイアウト・meta・JSONL の読み書きをここ 1 箇所に閉じる。
 * ストアはサンドボックスへマウントしない (作業フォルダだけをサンドボックスと共有する)。
 * JSONL は pi SDK と同形式で、書込みは「確定バイト位置」を基準にした追記 + 失敗時の復旧で行う。
 */
import { randomBytes } from "node:crypto";
import { existsSync, ftruncateSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentPayloadInfo, ThinkingLevel } from "./schema";

/** 作業フォルダ (サンドボックス側) の root 相対パス。会話ストアとは別の場所に置く */
export const SESSION_DIR_REL = ".pi-agent-gui/sessions";
export const SESSION_STORE_ENV = "PI_SESSION_STORE";
const SESSION_ID_PATTERN = /^[0-9a-f]{10}$/;

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
    super(`セッションの履歴ファイルが壊れています: ${reason}`);
  }
}

function badIdError(id: string): Error {
  return new Error(`セッション ID が不正です: ${id}`);
}

/**
 * store root を決める。既定は `<agentDir>/pi-agent-gui/sessions`。
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
  const dir = configured ? resolve(configured) : join(getAgentDir(), "pi-agent-gui", "sessions");
  const root = resolve(rootCwd);
  const rel = relative(root, dir);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
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

export function assertSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) throw badIdError(id);
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
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
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

/** セッションの作業フォルダ (root 相対)。BFF は作成せず、サンドボックスの mkdir に任せる */
export function sessionWorkdirRel(id: string): string {
  assertSessionId(id);
  return `${SESSION_DIR_REL}/${id}`;
}

export function sessionWorkdirAbs(rootCwd: string, id: string): string {
  return resolve(rootCwd, sessionWorkdirRel(id));
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

const KNOWN_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSONL を検証して読む。SDK の親探索は循環を検出しないため、`parentId` が前方参照でないことと
 * id の一意性をここで必ず確認する。末尾の途絶 (改行が無く parse できない行) だけは書込み途絶として捨てる。
 */
export function parseSessionFile(text: string, id: string): ParsedSessionFile {
  if (!text) return { kind: "empty" };
  const lines = text.split("\n");
  const lastHasNewline = text.endsWith("\n");
  // 末尾に改行が無い場合、最後の要素は途中の行の可能性がある
  const trailing = lastHasNewline ? undefined : lines.pop();
  const rawLines = lines.filter((line) => line.trim() !== "");

  const parsed: Record<string, unknown>[] = [];
  let completeBytes = 0;
  for (const line of rawLines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return { kind: "damaged", reason: "entry の JSON を解析できません" };
    }
    if (!isRecord(entry)) return { kind: "damaged", reason: "entry がオブジェクトではありません" };
    parsed.push(entry);
    completeBytes += Buffer.byteLength(`${line}\n`, "utf8");
  }
  // 改行で終わっていない末尾は、parse できれば完全な entry、できなければ書込み途絶として捨てる
  let needsSeparator = false;
  if (trailing !== undefined && trailing.trim() !== "") {
    try {
      const entry = JSON.parse(trailing);
      if (isRecord(entry)) {
        parsed.push(entry);
        completeBytes += Buffer.byteLength(trailing, "utf8");
        // 次の追記の前に改行を補う (entry 同士を連結させない)
        needsSeparator = true;
      }
    } catch {
      // 書込み途絶。確定位置は最後の完全行の末尾に置く
    }
  }

  const header = parsed[0];
  if (!header || header.type !== "session") {
    return { kind: "damaged", reason: "header がありません" };
  }
  if (header.id !== id) {
    return { kind: "damaged", reason: "header の id がフォルダ名と一致しません" };
  }
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
    if (!KNOWN_ENTRY_TYPES.has(type)) return { kind: "damaged", reason: `未知の entry type です: ${type}` };
    if (ids.has(entryId)) return { kind: "damaged", reason: `entry id が重複しています: ${entryId}` };
    const parentId = entry.parentId;
    if (parentId !== null && (typeof parentId !== "string" || !ids.has(parentId))) {
      return { kind: "damaged", reason: `parentId が前方参照です: ${String(parentId)}` };
    }
    if (type === "message" && !isRecord(entry.message)) {
      return { kind: "damaged", reason: "message entry に message がありません" };
    }
    if (type === "compaction" && (typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string")) {
      return { kind: "damaged", reason: "compaction entry の必須フィールドがありません" };
    }
    if (type === "model_change" && (typeof entry.provider !== "string" || typeof entry.modelId !== "string")) {
      return { kind: "damaged", reason: "model_change entry の必須フィールドがありません" };
    }
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
 * JSONL の追記ライター。確定バイト位置を基準に書き、部分書込みでは ftruncate してから再試行する。
 * 追記できない (並びが変わった / ファイルが無い) ときだけ全体を temp + rename で書き直す。
 */
export class SessionFileWriter {
  private committedBytes: number;
  private persistedCount: number;
  private lastPersistedId: string | null;
  private needsSeparator: boolean;
  /** 追記を停止した (復旧にも失敗した) ときだけ true */
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
      state.entries.length > 0 ? ((state.entries[state.entries.length - 1].id as string) ?? null) : null;
    this.needsSeparator = state.needsSeparator ?? false;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** 書込みを直列化する。失敗しても reject せず、writer の error に残す (in-memory の実行は止めない) */
  schedule(header: SessionHeader, entries: SessionEntryLike[]): Promise<void> {
    const run = this.tail.then(
      () => this.write(header, entries),
      () => this.write(header, entries),
    );
    this.tail = run.catch(() => {});
    return this.tail;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private write(header: SessionHeader, entries: SessionEntryLike[]): void {
    if (this.sealed) return;
    const path = sessionJsonlPath(this.id, this.storeDir);
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
      let written = 0;
      for (;;) {
        try {
          written += this.writeChunk(fd, buffer, written, buffer.length - written, start + written);
          if (written === buffer.length) break;
        } catch (error) {
          // 部分書込みを確定位置まで巻き戻してから 1 回だけ再試行する
          if (!this.rollback(fd, start)) {
            // 復旧できないときだけ追記を停止する (確定位置は進めないので原本は壊れない)
            this.sealed = true;
            this.lastError = `追記に失敗しました: ${messageFor(error)}`;
            return;
          }
        }
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
      while (written < buffer.length) {
        written += this.writeChunk(fd, buffer, written, buffer.length - written, written);
      }
    } catch (error) {
      closeSync(fd);
      rm(temp, { force: true });
      // 全体書直しの失敗は次回の保存で再試行できる (確定位置は変わっていない)
      this.lastError = `書き直しに失敗しました: ${messageFor(error)}`;
      return;
    }
    closeSync(fd);
    try {
      rename(temp, path);
    } catch (error) {
      rm(temp, { force: true });
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
