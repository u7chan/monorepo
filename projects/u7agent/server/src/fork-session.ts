/**
 * 会話の分岐 (forkSession) のうち、ファイルと保存の手順 (実行と巻き戻し) を持つ。どの失敗でどこまで
 * 戻すかをこの 1 module で追えるようにし、SessionStore には予約・確定・配信の順序だけを残す。
 * 競合の予約 (lifecycle / pendingMoves / deleting / closing) と record / descriptor / 送信キュー /
 * steering / run の所有は会話ストアに残す (docs/architecture.md の「所有者は 1 つに保つ」)。
 * ここからは port 越しにだけそれらへ触る。
 */
import { workspaceAbs } from "./app-paths";
import { httpError, messageFor } from "./errors";
import type { AgentPayloadInfo } from "./schema";
import type { SessionRecord } from "./session-record";
import {
  readSessionFile,
  removeSessionDir,
  sessionHeaderOf,
  SessionDamagedError,
  sessionJsonlPath,
  writeSessionDir,
  type PromptSnapshot,
  type SessionEntryLike,
  type SessionMeta,
} from "./session-store";
import { settledTitleAttemptOf, titleOriginOf, type TitleAttempt, type TitleOrigin } from "./session-title";

/** 手順が使う保存先。会話ストアの状態は含めない */
export interface ForkSessionFiles {
  storeDir: string;
  /** 子の header に書く cwd を解決するワークスペース root */
  rootCwd: string;
}

/** 手順が会話ストアへ要求する口。private を公開せずに切り出すための境界 */
export interface ForkSessionPort {
  /** 削除予約 / close。確定より前の各段の後でこれを見て、書いたものを戻す */
  isAborted(): boolean;
  /**
   * 共有している作業フォルダの存在確認 (無ければ 409)。409 への写像は復元の経路と同じ 1 か所に
   * 残したいので、ここでは検査の順序だけを持つ
   */
  requireSharedWorkdir(workdir: string): Promise<void>;
  /** 親の未保存 entry を確定させる。失敗は文字列で返す (in-memory の実行は止めない) */
  saveParent(record: SessionRecord): Promise<string | undefined>;
  /** 親の保存キューを流す */
  flushParent(record: SessionRecord): Promise<boolean>;
  /** 応答の実測を子の session_id へ写す。派生データなので失敗しても分岐を止めない */
  copyAssistantMetrics(fromId: string, toId: string): void;
  /** 複製した実測行を消す (子の保存に失敗したときと、確定後の巻き戻し) */
  deleteAssistantMetrics(id: string): void;
  /** 確定点。子の descriptor を一覧へ入れる */
  registerChild(id: string, meta: SessionMeta): void;
  /** 巻き戻し。子の record / descriptor を外し、SDK セッションと購読を閉じる */
  releaseChild(id: string): void;
}

export interface ForkParentInput {
  parent: SessionRecord;
  /** 親の作業フォルダ (共有の確認に使う) */
  workdir: string;
  /** 受け付けた時点の末尾 entry。entry が無ければ undefined */
  boundaryId: string | undefined;
}

/**
 * 境界までを複製できる状態にする。共有フォルダの確認 → 破損の検証 → 親の保存の確定 → 読み直し →
 * 境界までの切り出し。
 */
export async function copyForkEntries(
  files: ForkSessionFiles,
  port: ForkSessionPort,
  input: ForkParentInput,
): Promise<SessionEntryLike[]> {
  // 共有する作業フォルダが無ければ、空フォルダを作らずに 409 で断る
  await port.requireSharedWorkdir(input.workdir);
  if (port.isAborted()) throw httpError(404, "Session not found");
  // 破損した原本は writer の全体書直しで上書きされ得るため、必ず保存より前に検証する
  const before = await readSessionFile(files.storeDir, input.parent.id);
  if (before.parsed.kind === "damaged") {
    throw httpError(
      409,
      `${new SessionDamagedError(before.parsed.reason).message} (${sessionJsonlPath(input.parent.id, files.storeDir)})`,
    );
  }
  // live な親の未保存 entry を確定させる (検証の後。境界まではこの保存で読み直せる)
  const failure = await port.saveParent(input.parent);
  await port.flushParent(input.parent);
  const saveError = failure ?? input.parent.persistError ?? input.parent.writer?.error;
  if (saveError) throw httpError(500, `セッションの保存に失敗しました: ${saveError}`);
  if (port.isAborted()) throw httpError(404, "Session not found");
  const after = await readSessionFile(files.storeDir, input.parent.id);
  if (after.parsed.kind === "damaged") {
    throw httpError(500, "セッションの保存に失敗しました: 会話の記録を読み直せません");
  }
  const entries = after.parsed.kind === "ok" ? after.parsed.entries : [];
  const copied = copiedEntries(entries, input.boundaryId);
  if (!copied) throw httpError(500, "セッションの保存に失敗しました: 分岐の境界が記録に見つかりません");
  return copied;
}

/**
 * 境界 entry までの複製。境界が未指定 (境界の時点で entry 0 件) は空、指定された境界が
 * 読み直した記録に無ければ undefined (中途半端な履歴を子へ書かない)。
 */
function copiedEntries(entries: SessionEntryLike[], boundaryId: string | undefined): SessionEntryLike[] | undefined {
  if (boundaryId === undefined) return [];
  const index = entries.findIndex((entry) => entry.id === boundaryId);
  return index === -1 ? undefined : entries.slice(0, index + 1);
}

/** 子の meta へ写す親の値。record から読む分と、保存値 (meta) から読む分を分けて受け取る */
export interface ForkedSessionInput {
  /** 子の ID と作成時刻 */
  id: string;
  at: number;
  spaceId: string;
  /** 親の record。タイトルと要約の進行は保存値より record が新しい */
  parent: {
    id: string;
    title: string;
    titleOrigin: TitleOrigin;
    titleAttempt?: TitleAttempt;
    titleRequest?: string;
  };
  /** 親の SDK セッションの実効値。未指定は保存値へ落とす */
  model?: string;
  thinkingLevel?: string;
  /** agentId を指定したときだけ、現在の定義から作り直したスナップショット */
  agent?: { agentInfo: AgentPayloadInfo; promptSnapshot: PromptSnapshot };
  /** 親の作業フォルダ / 添付の持ち主 */
  workdirOwner: string;
  uploadsOwner: string;
}

/**
 * 子の meta。タイトル・由来・依頼本文・試行と、作業フォルダ / 添付の持ち主を親から写す。
 * ピン・通知・引き継ぎの記録・未送信は引き継がない。
 */
export function forkedSessionMeta(current: SessionMeta, input: ForkedSessionInput): SessionMeta {
  const model = input.model ?? current.model;
  const thinkingLevel = input.thinkingLevel ?? current.thinkingLevel;
  const attempt = settledTitleAttemptOf(input.parent.titleAttempt ?? current.titleAttempt);
  const titleRequest = input.parent.titleRequest ?? current.titleRequest;
  return {
    spaceId: input.spaceId,
    version: 1,
    id: input.id,
    title: input.parent.title || current.title,
    createdAt: input.at,
    lastUsedAt: input.at,
    // 表示件数は子を開いたときに実履歴から補正する (分岐の成否には影響しない)
    messageCount: current.messageCount,
    agentId: input.agent?.agentInfo.id ?? current.agentId,
    agent: input.agent?.agentInfo ?? current.agent,
    promptSnapshot: input.agent?.promptSnapshot ?? current.promptSnapshot,
    ...(current.projectCwd ? { projectCwd: current.projectCwd } : {}),
    ...(current.projectName ? { projectName: current.projectName } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    titleOrigin: input.parent.titleOrigin ?? titleOriginOf(current),
    // 親に試行が無ければ子も未試行 (一度も正常完了していないなら子の最初の完了で 1 回だけ要約され得る)。
    // pending は子だけ interrupted に終端化し、親の meta / titleTask は変えない
    ...(attempt ? { titleAttempt: attempt } : {}),
    ...(titleRequest ? { titleRequest } : {}),
    parentSessionId: input.parent.id,
    forkedAt: input.at,
    workdirOwner: input.workdirOwner,
    uploadsOwner: input.uploadsOwner,
  };
}

export interface ForkWriteInput {
  /** 子の ID */
  id: string;
  parentId: string;
  /** 確定点で保存する meta */
  meta: SessionMeta;
  entries: SessionEntryLike[];
  /** 子の header に書く cwd。親の作業フォルダ (子はそれを共有する) */
  workdir: string;
}

/**
 * 子の store を書き、確定点を越える。実測の複製は派生データなので失敗しても分岐を止めない。
 * 保存に失敗したときは複製した実測を消し、子を残さない。
 */
export async function writeForkedSession(
  files: ForkSessionFiles,
  port: ForkSessionPort,
  input: ForkWriteInput,
): Promise<void> {
  // 表示用の実測は派生データ。複製できなくても分岐は成功させる (SDK の記録値へ落ちる)
  port.copyAssistantMetrics(input.parentId, input.id);
  try {
    await writeSessionDir(files.storeDir, input.id, {
      meta: input.meta,
      header: sessionHeaderOf(input.meta, workspaceAbs(files.rootCwd, input.workdir)),
      entries: input.entries,
    });
  } catch (error) {
    port.deleteAssistantMetrics(input.id);
    throw httpError(500, `セッションの保存に失敗しました: ${messageFor(error)}`);
  }
  port.registerChild(input.id, input.meta);
}

/**
 * 確定後の巻き戻し。子の open に失敗したとき・open 中に DELETE されたときも、store だけの半端な
 * 会話を残さない。
 */
export async function discardForkedSession(files: ForkSessionFiles, port: ForkSessionPort, id: string): Promise<void> {
  port.releaseChild(id);
  port.deleteAssistantMetrics(id);
  await removeSessionDir(files.storeDir, id).catch(() => {});
}
