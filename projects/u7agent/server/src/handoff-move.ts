/**
 * 会話の引き継ぎ (moveSession) のうち、ファイルと保存の手順 (実行と巻き戻し) を持つ。どの失敗でどこまで
 * 戻すかをこの 1 module で追えるようにし、SessionStore には予約・確定・配信の順序だけを残す。
 * 競合の予約 (lifecycle / pendingMoves / deleting / closing) と record / descriptor の所有は会話ストアに
 * 残す (docs/architecture.md の「所有者は 1 つに保つ」)。ここからは port 越しにだけそれらへ触る。
 */
import { dirname, posix } from "node:path";
import type { CwdKeyStore } from "./app-db";
import { httpError, messageFor } from "./errors";
import { buildHandoffSection, HANDOFF_FILE_NAME, type HandoffMemoSection } from "./handoff-memo";
import { sandboxFailureStatus } from "./http";
import type { SecretMasker } from "./redact";
import type { SandboxHandoffClient, SandboxMoveClient, SandboxWorkspaceClient } from "./sandbox/client";
import { SandboxRequestError } from "./sandbox/client";
import { SANDBOX_MAX_HANDOFF_BYTES } from "./sandbox/protocol";
import type { SessionRecord } from "./session-record";
import { readSessionFile, removeSessionHistory, type SessionMeta } from "./session-store";

/** ファイルと保存の手順が使うサンドボックスと保存先。会話ストアの状態は含めない */
export interface HandoffMoveFiles {
  storeDir: string;
  moveSandbox: SandboxMoveClient;
  workspace: SandboxWorkspaceClient;
  handoffSandbox: SandboxHandoffClient;
  /** cwd をキーにする行の付け替え。アプリデータを持たない構成では null */
  cwdKeys: CwdKeyStore | null;
}

/** 手順が会話ストアへ要求する口。private を公開せずに切り出すための境界 */
export interface HandoffMovePort {
  /** 削除予約 / close。確定より前の各段の後でこれを見て、移したものを逆順に戻す */
  isAborted(): boolean;
  /** 確定点。meta を保存し、未ロードの一覧と live な record の両方へ反映する */
  saveMeta(meta: SessionMeta): Promise<void>;
  /** 確定後の片付け。live な record を open から外し、未完了の保存を流す */
  releaseRecord(record: SessionRecord): Promise<void>;
  /** 応答の実測行。履歴の削除に成功した後だけ消す */
  deleteAssistantMetrics(id: string): void;
}

export interface HandoffMemoInput {
  id: string;
  /** 材料にする現在のタイトルとエージェント名 */
  title: string;
  fromAgent: string;
  toAgent: string;
  operationId: string;
  /** 節の日時 (epoch ms) */
  at: number;
  masker: SecretMasker;
  moving: boolean;
  fromWorkdir: string;
  toWorkdir: string;
}

/** 下準備の結果。既存の全文は上限の判定と、巻き戻しの照合に使う */
export interface PreparedHandoffMemo {
  path: string;
  section: HandoffMemoSection;
  existing: string;
}

/**
 * メモの下準備 (副作用なし)。材料と既存の HANDOFF.md をここで読み、会話の状態を変える前に拒否する。
 * 追記後の全文を組み立てるのはここでの上限判定のためで、書込みは排他の中で再読取りして再適用する。
 */
export async function prepareHandoffMemo(
  files: Pick<HandoffMoveFiles, "storeDir" | "handoffSandbox">,
  input: HandoffMemoInput,
): Promise<PreparedHandoffMemo | undefined> {
  const memoPath = posix.join(input.toWorkdir, HANDOFF_FILE_NAME);
  const { parsed } = await readSessionFile(files.storeDir, input.id);
  if (parsed.kind === "damaged") {
    throw httpError(
      400,
      `保存された会話を読めないためメモを作れません (${parsed.reason})。「メモを作る」を外すと引き継げます`,
    );
  }
  const section = buildHandoffSection({
    entries: parsed.kind === "ok" ? parsed.entries : [],
    title: input.title,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    operationId: input.operationId,
    at: input.at,
    masker: input.masker,
  });
  if (!section) throw httpError(400, "メモにできる会話がまだありません。「メモを作る」を外すと引き継げます");
  const readPath = input.moving ? posix.join(input.fromWorkdir, HANDOFF_FILE_NAME) : memoPath;
  let existing = "";
  try {
    existing = (await files.handoffSandbox.readHandoff(readPath)).text;
  } catch (error) {
    if (!(error instanceof SandboxRequestError) || error.status !== 404) {
      throw httpError(
        400,
        `作業フォルダの HANDOFF.md を読めないためメモを作れません (${messageFor(error)})。「メモを作る」を外すと引き継げます`,
      );
    }
  }
  const total =
    Buffer.byteLength(existing, "utf8") +
    // 先頭見出しのハッシュが既にあるときは追記されないので、追記分を足さずに評価する
    // (確定前の失敗からの再試行で、全文がちょうど上限でも通す)
    (existing.split("\n", 1)[0]?.includes(section.hash) ? 0 : Buffer.byteLength(section.text, "utf8"));
  if (total > SANDBOX_MAX_HANDOFF_BYTES) {
    throw httpError(400, "HANDOFF.md が上限 (2 MiB) を超えるためメモを作れません。「メモを作る」を外すと引き継げます");
  }
  return { path: memoPath, section, existing };
}

export interface HandoffMoveInput {
  id: string;
  moving: boolean;
  fromWorkdir: string;
  fromUploads: string;
  toWorkdir: string;
  toUploads: string;
  /** 確定点で保存する meta (引き継ぎ先のエージェント・`messageCount: 0`・`handoffCleanup: true`) */
  updated: SessionMeta;
  memo: PreparedHandoffMemo | undefined;
  live: SessionRecord | undefined;
}

/** `aborted` は削除予約 / close で止めた (応答を返さない)。`moved` は確定済み */
export type HandoffMoveResult = { kind: "aborted" } | { kind: "moved"; cleanupPending: boolean };

/**
 * meta の書換えを確定点にし、それより前の失敗だけを逆順に戻す。確定後の失敗は戻さず、片付けの印を
 * 残して次回の保存 / 開くときに再試行する。移動先に残った空ディレクトリは無害なので消さない。
 */
export async function applyHandoffMove(
  files: HandoffMoveFiles,
  port: HandoffMovePort,
  input: HandoffMoveInput,
): Promise<HandoffMoveResult> {
  const undo: Array<() => Promise<void> | void> = [];
  const rollback = async (): Promise<string | undefined> => {
    let failure: string | undefined;
    for (const step of [...undo].reverse()) {
      try {
        await step();
      } catch (error) {
        failure = failure ?? messageFor(error);
      }
    }
    return failure;
  };
  const abortMove = async (): Promise<HandoffMoveResult> => {
    const failure = await rollback();
    if (failure) throw httpError(500, `移動を中止し、元の場所へ戻せませんでした: ${failure}`);
    return { kind: "aborted" };
  };
  const failMove = async (error: unknown): Promise<never> => {
    const failure = await rollback();
    if (failure) throw httpError(500, `移動に失敗し、元の場所へ戻せませんでした: ${failure}`);
    throw error instanceof SandboxRequestError ? httpError(sandboxFailureStatus(error), error.message) : error;
  };

  try {
    if (input.moving) {
      // 移動先の親は move が要求する (既存ディレクトリは成功扱いなので再実行でも冪等)
      await files.workspace.createDir(dirname(input.toWorkdir));
      await files.workspace.createDir(dirname(input.toUploads));
      if (port.isAborted()) return abortMove();

      if (await moveSandboxEntry(files.moveSandbox, input.fromWorkdir, input.toWorkdir)) {
        undo.push(async () => {
          await files.moveSandbox.moveEntry(input.toWorkdir, input.fromWorkdir);
        });
      }
      if (port.isAborted()) return abortMove();

      if (await moveSandboxEntry(files.moveSandbox, input.fromUploads, input.toUploads)) {
        undo.push(async () => {
          await files.moveSandbox.moveEntry(input.toUploads, input.fromUploads);
        });
      }
      if (port.isAborted()) return abortMove();

      // cwd をキーにする行は移動先へ付け替える (値の AAD は cwd を含まないので再暗号化は不要)
      try {
        files.cwdKeys?.moveCwd(input.fromWorkdir, input.toWorkdir);
      } catch (error) {
        throw httpError(500, `環境変数とサービス実績の付け替えに失敗しました: ${messageFor(error)}`);
      }
      undo.push(() => files.cwdKeys?.moveCwd(input.toWorkdir, input.fromWorkdir));
    }

    // メモは確定より前に書く (確定した時点でメモの状態が最終になる)。失敗したらここまでの移動を戻す
    const memo = input.memo;
    if (memo) {
      const written = await files.handoffSandbox.writeHandoff({
        path: memo.path,
        section: memo.section.text,
        dedupeKey: memo.section.hash,
      });
      if (written.created) {
        // 新規作成の rollback は、自分が書いた内容と一致するときだけ消す。既存への追記は戻さない
        const expected = `${memo.section.text}${memo.existing}`;
        undo.push(async () => {
          await files.handoffSandbox.rollbackHandoff({ path: memo.path, expected });
        });
      }
    }
    if (port.isAborted()) return abortMove();

    await port.saveMeta(input.updated);
  } catch (error) {
    return failMove(error);
  }

  // ここから先は meta が確定済み
  let cleanupPending = false;
  if (input.live) await port.releaseRecord(input.live);
  try {
    await removeSessionHistory(files.storeDir, input.id);
  } catch {
    cleanupPending = true;
  }
  if (!cleanupPending) {
    port.deleteAssistantMetrics(input.id);
    const cleared: SessionMeta = { ...input.updated };
    delete cleared.handoffCleanup;
    try {
      await port.saveMeta(cleared);
    } catch {
      // 確定は済んでいる。印が残るだけなので次の保存で再試行する
      cleanupPending = true;
    }
  }
  return { kind: "moved", cleanupPending };
}

/**
 * 作業フォルダ / 添付を 1 つ移す。元が無い (404) は「運ぶものが無い」として false を返し、
 * 移動先が既にある (409) はマージできないため、手動での退避先の削除を案内する。
 */
async function moveSandboxEntry(client: SandboxMoveClient, from: string, to: string): Promise<boolean> {
  try {
    await client.moveEntry(from, to);
    return true;
  } catch (error) {
    if (!(error instanceof SandboxRequestError)) throw error;
    if (error.status === 404) return false;
    if (error.status === 409) {
      throw httpError(
        409,
        `移動先に既存のエントリがあります。退避先を削除してから再実行してください: ${error.message}`,
      );
    }
    throw error;
  }
}
