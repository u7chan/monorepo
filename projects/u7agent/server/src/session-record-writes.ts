/**
 * 会話レコードの保存経路 (meta / JSONL / 送信対応記録)。書込みの順序と失敗時の扱いが仕様なので、
 * SessionStore の状態遷移とは分けてこの 1 つの協調オブジェクトに閉じる。
 * 保存先と「その record がまだ現役か」だけを SessionStore から受け取り、private は公開しない。
 */
import { workspaceAbs } from "./app-paths";
import { messageFor } from "./errors";
import { modelLabel } from "./model-ref";
import type { PiSessionLike } from "./pi-runtime";
import type { SessionRecord } from "./session-record";
import { displayableMessages, truncate } from "./session-projection";
import {
  ASSISTANT_ID_FIELD,
  RUN_ID_FIELD,
  SEND_ID_FIELD,
  sessionHeaderOf,
  writeSessionMeta,
  type SessionEntryLike,
  type SessionMeta,
  type SessionSends,
} from "./session-store";
import { TITLE_REQUEST_MAX } from "./session-title";

/** 保存経路が SessionStore へ要求する口。private を公開せずに切り出すための境界 */
export interface SessionRecordWritesPort {
  /** 保存先。null は永続化なし (メモリのみ) */
  storeDir(): string | null;
  /** ワークスペース root。workdir の絶対化に使う */
  rootCwd: string;
  /** 削除済み・別世代に差し替わった record は書かない (store を復活させない) */
  isLive(record: SessionRecord): boolean;
  /** 保存した meta を一覧の射影 (descriptors) へ反映する */
  rememberMeta(meta: SessionMeta): void;
  /** 送信対応記録の書込み (テストは差し替える) */
  writeSendsFile: (storeDir: string, id: string, sends: SessionSends) => void;
}

export function entriesOf(session: PiSessionLike): SessionEntryLike[] {
  const manager = session.sessionManager as { getEntries?(): unknown[]; getBranch?(): unknown[] } | undefined;
  const entries = manager?.getEntries?.() ?? manager?.getBranch?.() ?? [];
  return Array.isArray(entries) ? (entries as SessionEntryLike[]) : [];
}

/** meta / JSONL / 送信対応記録の書込み。順序と失敗時の扱いはこの 1 つの実装に閉じる */
export class SessionRecordWrites {
  constructor(private readonly port: SessionRecordWritesPort) {}

  /**
   * meta と JSONL の書込みを直列化する。失敗は record.persistError に残す (in-memory の実行は止めない)。
   * `jsonl: false` は履歴が変わっていない呼び出し用 (meta だけを書く)。
   */
  persist(record: SessionRecord, { jsonl = true }: { jsonl?: boolean } = {}): Promise<string | undefined> {
    const storeDir = this.port.storeDir();
    if (!record.writer || !storeDir) return Promise.resolve(undefined);
    const run = async (): Promise<string | undefined> => {
      // 削除済み・別世代に差し替わった record は書かない (store を復活させない)
      if (!this.port.isLive(record)) return undefined;
      const session = record.session;
      const meta: SessionMeta = {
        ...record.meta,
        id: record.id,
        title: record.title,
        lastUsedAt: record.lastUsedAt,
        messageCount: displayableMessages(session, workspaceAbs(this.port.rootCwd, record.workdir)).length,
        agentId: record.agentId,
        agent: record.agent,
        promptSnapshot: record.promptSnapshot,
        ...(record.projectCwd ? { projectCwd: record.projectCwd } : {}),
        ...(record.projectName ? { projectName: record.projectName } : {}),
        ...(modelLabel(session.model) ? { model: modelLabel(session.model) } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      };
      if (!meta.projectCwd) {
        delete meta.projectCwd;
        delete meta.projectName;
      }
      // record.meta の古い値を残さない (Off へ戻した会話が再起動で On に戻らないように)
      if (record.notify) meta.notify = true;
      else delete meta.notify;
      if (record.pinned) meta.pinned = true;
      else delete meta.pinned;
      meta.titleOrigin = record.titleOrigin;
      if (record.titleAttempt) meta.titleAttempt = record.titleAttempt;
      else delete meta.titleAttempt;
      if (record.titleRequest) meta.titleRequest = truncate(record.titleRequest, TITLE_REQUEST_MAX);
      else delete meta.titleRequest;
      record.meta = meta;
      this.port.rememberMeta(meta);
      // 今回の保存だけを評価する (過去の失敗は成功で消す)
      let failure: string | undefined;
      // writer へ渡すのと同じスナップショットを使う。await 中に SDK が追記した entry を
      // 保存済みとして対応表へ入れない (次の保存で書かれる)。run id は entry 自身へ写す
      const entries = this.annotateSendIds(record, entriesOf(session));
      try {
        await writeSessionMeta(storeDir, meta);
        if (jsonl) {
          await record.writer?.schedule(
            sessionHeaderOf(meta, workspaceAbs(this.port.rootCwd, record.workdir)),
            entries,
          );
        }
      } catch (error) {
        failure = messageFor(error);
      }
      failure = failure ?? record.writer?.error;
      // JSONL に載った user entry だけを保存済みとして扱う (書けていない entry を対応表へ入れない)。
      // meta だけの保存 (jsonl: false) では entry の保存を確かめられないので触らない
      if (jsonl && !failure) this.syncSendMap(record, entries);
      // 送信対応記録は失敗しても dirty を残し、次の persist / flush でやり直す
      this.writeSends(record);
      record.persistError = failure;
      if (failure && record.persistErrorLogged !== failure) {
        record.persistErrorLogged = failure;
        console.warn(`[u7agent] セッションの保存に失敗しました (${record.id}): ${failure}`);
      }
      if (!failure) record.persistErrorLogged = undefined;
      return failure;
    };
    const next = record.persistTail.then(run, run);
    const result = next.catch((error: unknown) => {
      const failure = messageFor(error);
      record.persistError = failure;
      if (record.persistErrorLogged !== failure) {
        record.persistErrorLogged = failure;
        console.warn(`[u7agent] セッションの保存に失敗しました (${record.id}): ${failure}`);
      }
      return failure;
    });
    record.persistTail = result.then(() => {});
    return result;
  }

  async flush(record: SessionRecord): Promise<boolean> {
    await record.persistTail.catch(() => {});
    await record.writer?.flush();
    // 最後の persist で書けなかった送信対応記録をここでも試す (close / sweep の最終保存)
    return this.writeSends(record);
  }

  /** 進行中の保存を待つ (移動で meta を書き換える前に古い値の書込みを終わらせる) */
  async drain(record: SessionRecord): Promise<void> {
    await record.persistTail.catch(() => {});
    await record.writer?.flush().catch(() => {});
  }

  /**
   * 送信対応記録の保存。失敗しても会話の実行 / 保存は止めず、dirty を残して次の persist / flush で
   * やり直す (メモリだけ進めてディスクが古いままだと、再起動後に保存済みの送信を未送信として
   * 再実行できてしまう)。
   */
  writeSends(record: SessionRecord): boolean {
    const storeDir = this.port.storeDir();
    if (!record.writer || !storeDir) return true;
    if (!record.sendsDirty) return true;
    try {
      this.port.writeSendsFile(storeDir, record.id, { unsent: record.unsentSends });
      record.sendsDirty = false;
      record.sendsError = undefined;
      return true;
    } catch (error) {
      record.sendsError = messageFor(error);
      console.warn(`[u7agent] 未送信記録の保存に失敗しました (${record.id}): ${record.sendsError}`);
      return false;
    }
  }

  /**
   * 渡された entry スナップショットのうち、JSONL へ書けた user entry の送信対応を控え、保存済みに
   * なった分を「未送信」から外す。`persist` が writer へ渡したのと同じ配列を渡す (await 中に SDK が
   * 追記した entry を保存済みにしないため)。
   */
  private syncSendMap(record: SessionRecord, entries: SessionEntryLike[]): void {
    if (!record.writer || !this.port.storeDir()) return;
    let changed = false;
    for (const entry of entries) {
      if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") continue;
      const message = entry.message as { role?: unknown } | undefined;
      if (!message || message.role !== "user") continue;
      const send = record.userMessageSends.get(message);
      if (send === undefined) continue;
      const known = record.entrySends.get(entry.id);
      if (known?.sendId === send.sendId && known.runId === send.runId) continue;
      record.entrySends.set(entry.id, send);
      const index = record.unsentSends.findIndex((item) => item.sendId === send.sendId);
      if (index !== -1) record.unsentSends.splice(index, 1);
      record.injectedSends.delete(send.sendId);
      changed = true;
    }
    if (changed) {
      record.sendsDirty = true;
      this.writeSends(record);
    }
  }

  /**
   * user message entry へ送信IDと実行IDを写す。entry と送信の対応を JSONL 自身に持たせ、
   * 別ファイル (sends.json) の書込みだけ失敗しても再起動後に対応を失わない。SDK は未知の
   * フィールドをそのまま保持するため、SDK 形式は壊れない。
   */
  private annotateSendIds(record: SessionRecord, entries: SessionEntryLike[]): SessionEntryLike[] {
    return entries.map((entry) => {
      if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") return entry;
      const message = entry.message as { role?: unknown } | undefined;
      if (message?.role === "assistant") {
        const assistantId = record.assistantMessageIds.get(message);
        if (assistantId === undefined || entry[ASSISTANT_ID_FIELD] === assistantId) return entry;
        return { ...entry, [ASSISTANT_ID_FIELD]: assistantId };
      }
      if (!message || message.role !== "user") return entry;
      const send = record.userMessageSends.get(message) ?? record.entrySends.get(entry.id);
      if (send === undefined) return entry;
      if (entry[SEND_ID_FIELD] === send.sendId && entry[RUN_ID_FIELD] === send.runId) return entry;
      return {
        ...entry,
        [SEND_ID_FIELD]: send.sendId,
        ...(send.runId === undefined ? {} : { [RUN_ID_FIELD]: send.runId }),
      };
    });
  }
}
