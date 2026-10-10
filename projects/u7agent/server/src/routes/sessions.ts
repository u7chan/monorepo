import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { MAX_ATTACHMENT_BYTES, composePrompt, normalizeAttachmentPaths, toAttachmentPath } from "../attachments";
import { sessionUploadsRel, workspaceAbs } from "../app-paths";
import { sandboxFailure, sandboxNotConfigured } from "../http";
import { HISTORY_PAGE_LIMIT_MAX, type HistoryPageResult } from "../history-projection";
import { isValidEntryName } from "../sandbox/protocol";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../sandbox/client";
import { expandSkillCommand, hasProjectSkills, listSessionSkills, type SessionSkillsInput } from "../session-skills";
import { resolveAgentSkills } from "../sessions";
import type { SpaceStore } from "../spaces";
import {
  FileUploadSchema,
  type AnswerQuestionBody,
  type CreateSessionBody,
  type MoveSessionBody,
  type PostMessageBody,
  type UpdateSessionNotifyBody,
  type UpdateSessionPinnedBody,
  type UpdateSessionSettingsBody,
  type UpdateSessionTitleBody,
} from "../schema";
import type { SessionRecord, SessionStore } from "../sessions";

// sessions 側の上限とは別 (HTTP 層の契約)
const MAX_MESSAGE_CHARS = 20_000;
const SSE_HEARTBEAT_MS = 15_000;

/** streamSSE は charset 等を設定しないため、SSE のヘッダをここで上書きする */
function withSseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export function createSessionRoutes({
  store,
  workspace,
  spaces,
}: {
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  spaces: SpaceStore;
}) {
  // 未ロードのセッションはストアから復元する (SDK ロードを含むため非同期)
  const resolveRecord = (c: Context) => store.resolve(c.req.param("id") ?? "");

  /** セッションのスキル解決に渡す入力。ファイルスキルはサンドボックス未設定なら落とす */
  const skillsInputOf = (record: SessionRecord): SessionSkillsInput => ({
    rootCwd: store.rootCwd,
    relativeCwd: record.workdir,
    client: workspace ?? undefined,
    promptSnapshot: record.promptSnapshot,
    agentSkills: record.agent.skills,
  });

  const stop = async (c: Context) => {
    const record = await resolveRecord(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    const result = await store.stop(record);
    return c.json({ sessionId: record.id, ...result });
  };

  return {
    list: (c: Context) => c.json({ sessions: store.list(c.req.query("spaceId") ?? "default") }),

    create: async (c: Context, body: CreateSessionBody) => {
      const record = await store.create({
        spaceId: body.spaceId,
        agentId: body.agentId,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
        projectId: body.projectId,
        notify: body.notify,
      });
      return c.json(store.payload(record), 201);
    },

    get: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      return c.json(store.payload(record));
    },

    /**
     * 全履歴のカーソルページ。`before` より古い範囲を `limit` 件返す。
     * 不明なカーソルは空の成功にせず 400 で返し、クライアントのページ飛びを防ぐ。
     */
    history: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const rawLimit = c.req.query("limit");
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_PAGE_LIMIT_MAX) {
          return c.json({ error: `limit must be an integer between 1 and ${HISTORY_PAGE_LIMIT_MAX}` }, 400);
        }
        limit = parsed;
      }
      const before = c.req.query("before") || undefined;
      const result: HistoryPageResult = store.history(record, {
        ...(before ? { before } : {}),
        ...(limit ? { limit } : {}),
      });
      if (!result.ok) return c.json({ error: "Unknown history cursor" }, 400);
      return c.json(result.page);
    },

    updateSettings: async (c: Context, body: UpdateSessionSettingsBody) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      if (body.model === undefined && body.thinkingLevel === undefined) {
        return c.json({ error: "model or thinkingLevel is required" }, 400);
      }
      const payload = await store.updateSettings(record, {
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      return c.json(payload);
    },

    /** 通知トグル。busy でも成功し、応答は live / 未ロード共通の `{ sessionId, notify }` */
    updateNotify: async (c: Context, body: UpdateSessionNotifyBody) => {
      const result = await store.setNotify(c.req.param("id") ?? "", body.notify);
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    /** ピン留め。live / 未ロード共通で busy でも成功し、保存に失敗したときは 500 を返す。 */
    updatePinned: async (c: Context, body: UpdateSessionPinnedBody) => {
      const result = await store.setPinned(c.req.param("id") ?? "", body.pinned);
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    /**
     * 会話タイトルの変更。notify と同じく busy でも成功し、応答は `{ sessionId, title }`。
     * 空・空白だけは store が 400 で拒否する。
     */
    updateTitle: async (c: Context, body: UpdateSessionTitleBody) => {
      const result = await store.setTitle(c.req.param("id") ?? "", body.title);
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    /**
     * 未所属セッションの引っ越し。履歴は破棄され、作業フォルダ / 添付 / cwd キーの行が移動先へ移る。
     * 移動先の検証はスペース側の規則 (未知は 404) に任せ、要求元の照合は `sessionSpaceGuard` が済ませている。
     */
    move: async (c: Context, body: MoveSessionBody) => {
      const result = await store.move(c.req.param("id") ?? "", spaces.require(body.spaceId));
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    remove: async (c: Context) => {
      // 未ロードでも消せる (SDK を開かない。履歴だけ削除し、作業フォルダは残す)
      const deleted = await store.deleteSession(c.req.param("id") ?? "");
      if (!deleted) return c.json({ error: "Session not found" }, 404);
      return c.json({ ok: true });
    },

    stop,

    /** 手動圧縮。完了まで待って実効状態を返し、失敗は理由に応じた status (400 / 409 / 500) を返す */
    compact: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      return c.json(await store.compact(record));
    },

    /**
     * セッションで使えるスキル (プロジェクト / 共通 / 組み込み / Agent 割り当て)。
     * 本文は載せない (送信時に取り直す) ため、応答は一覧と優先順位の表示に使う。
     * 発見に失敗したら 502 にする (組み込みだけを見せて「使えるスキルはありません」にしない)。
     */
    skills: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      if (!workspace) return sandboxNotConfigured(c);
      try {
        const skills = await listSessionSkills({ ...skillsInputOf(record), strict: true });
        return c.json({
          sessionId: record.id,
          cwd: record.workdir,
          projectSkills: hasProjectSkills(record.workdir),
          skills,
        });
      } catch (error) {
        // 想定外の内部エラーは 500 のままにする (サンドボックス由来だけ 502 へ寄せる)
        if (!(error instanceof SandboxRequestError)) throw error;
        return sandboxFailure(c, error);
      }
    },

    /**
     * セッション未確定 (新規チャット) のスキル一覧。作成と同じ入力で解決し、送信後に読み込まれる一覧と
     * 一致させる。`sessionId` を持たないため、セッションが確定したら GET /api/sessions/:id/skills へ切り替える。
     */
    previewSkills: async (c: Context) => {
      // サンドボックス未設定ではセッション作成も 503 になるため、組み込みだけへ縮退させない
      if (!workspace) return sandboxNotConfigured(c);
      const project = store.resolveProject(c.req.query("projectId") || undefined);
      const { agentInfo, promptSnapshot } = resolveAgentSkills(store.catalog, c.req.query("agentId") || undefined);
      // 作成と同じ前提条件 (永続化あり × プロジェクト選択) を確認し、出した一覧がそのまま送れるようにする
      if (project) await store.requireProjectDir(project.cwd);
      const relativeCwd = project?.cwd ?? "";
      try {
        const skills = await listSessionSkills({
          rootCwd: store.rootCwd,
          relativeCwd,
          client: workspace,
          promptSnapshot,
          agentSkills: agentInfo.skills,
          strict: true,
        });
        return c.json({ cwd: relativeCwd, projectSkills: hasProjectSkills(relativeCwd), skills });
      } catch (error) {
        // 想定外の内部エラーは 500 のままにする (サンドボックス由来だけ 502 へ寄せる)
        if (!(error instanceof SandboxRequestError)) throw error;
        return sandboxFailure(c, error);
      }
    },

    postMessage: async (c: Context, body: PostMessageBody) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      // 未送信メッセージの再送は、保存済みの生の本文をサーバー側で使う。クライアントへは表示用の
      // マスク済みの本文しか渡らないため、本文を送り直させるとキーが欠けたまま送られる
      if (body.resendRunId !== undefined) {
        const result = store.resend(record, body.resendRunId);
        if (!result) return c.json({ error: "この送信は再開できません（保存済みか破棄済みです）" }, 409);
        return c.json({ sessionId: record.id, status: store.statusOf(record), ...result }, 202);
      }
      const attachments = normalizeAttachmentPaths(body.attachments, sessionUploadsRel(record.id, record.meta.spaceId));
      const text = (body.text ?? "").trim();
      // 本文が空でも添付だけで送れる (注記だけのプロンプトになる)
      if (!text && attachments.length === 0) return c.json({ error: "text is required" }, 400);
      if (text.length > MAX_MESSAGE_CHARS) {
        return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 413);
      }
      // SDK の /skill: 展開は BFF プロセスの readFileSync で動くため、Docker ではファイル / 組み込み /
      // カタログのどれも展開できない。アプリ側で本文を取り直してから prompt() へ渡す (docs/api-sessions.md)。
      const prompt = await expandSkillCommand(text, skillsInputOf(record));
      // 実行 (またはキュー位置) は SessionStore がバックグラウンドで進めるため即座に返す。
      // 注記は履歴とモデルへ渡すためここで合成し、title は注記と展開結果を除いた本文から作る。
      // 保存先はプロジェクトの外にあるため、モデルへは絶対パスで知らせる
      const result = store.postMessage(
        record,
        composePrompt(
          prompt,
          attachments.map((path) => workspaceAbs(store.rootCwd, path)),
        ),
        // 展開後の本文でタイトルを作ると `<skill …>` が並ぶので、ユーザーが打った本文を使う
        { titleSource: text },
      );
      return c.json({ sessionId: record.id, status: store.statusOf(record), ...result }, 202);
    },

    /**
     * ask_user の回答。回答は 1 回だけ成立し、質問ごとの「回答しない」もここで受ける。
     * 回答待ちでない (実行前 / 終了後) は 404、回答済みは 409、内容の不一致は 400。
     */
    answerQuestion: async (c: Context, body: AnswerQuestionBody) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const result = store.answerQuestion(record, c.req.param("toolCallId") ?? "", body.answers);
      if (result.status === "missing") return c.json({ error: "回答待ちの質問が見つかりません" }, 404);
      if (result.status === "answered") return c.json({ error: "この質問には回答済みです" }, 409);
      if (result.status === "invalid") return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    },

    /**
     * 未送信メッセージの破棄。再送が実行中 / キュー待ちの分は消せず 409、記録が無い (別タブで
     * 再送済み / 破棄済み) は 404。
     */
    discardUnsent: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const result = store.discardUnsent(record, c.req.param("runId") ?? "");
      if (result === "missing") return c.json({ error: "未送信のメッセージが見つかりません" }, 404);
      if (result === "running") return c.json({ error: "再送が実行中のため破棄できません" }, 409);
      return c.json({ ok: true });
    },

    /**
     * 選択時の即時アップロード。bodyGuard (既定 64 KiB 上限 / text 化) を通さないよう、app.ts では
     * このルートを bodyGuard より先に登録する。保存先は所属スペースの添付置き場 (app-paths.ts の
     * `sessionUploadsRel`。プロジェクトのリポジトリ内にファイルを作らない)。
     */
    uploadFile: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const name = c.req.query("name") ?? "";
      if (!isValidEntryName(name)) return c.json({ error: `Invalid file name: ${name}` }, 400);
      // サンドボックスはストリームを数えて 413 を返すが、事前に分かる分はここで止める (本文を送らずに済む)
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: `File is too large (max ${MAX_ATTACHMENT_BYTES} bytes)` }, 413);
      }
      const uploadsDirRel = sessionUploadsRel(record.id, record.meta.spaceId);
      try {
        const uploaded = await workspace.uploadFile({
          dir: uploadsDirRel,
          name,
          body: c.req.raw.body,
          signal: c.req.raw.signal,
        });
        const parsed = FileUploadSchema.safeParse(uploaded);
        if (!parsed.success) return c.json({ error: "サンドボックスのアップロード応答が不正です" }, 502);
        // サンドボックスは root 相対を返す。保存先の外や別セッションを指す応答は 502 で止める
        const path = toAttachmentPath(uploadsDirRel, parsed.data.path);
        if (!path) return c.json({ error: "サンドボックスのアップロード応答が不正です" }, 502);
        return c.json({ sessionId: record.id, ...parsed.data, path }, 201);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    events: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      // 有効な Last-Event-ID (`<generation>:<seq>`) を優先し、無効なら query の generation + after を使う
      const lastEventId = c.req.header("Last-Event-ID");
      const queryGeneration = c.req.query("generation");
      const queryAfter = c.req.query("after");
      const query = queryGeneration ? `${queryGeneration}:${queryAfter ?? "0"}` : queryAfter;
      const after = lastEventId?.includes(":") ? lastEventId : query;

      return withSseHeaders(
        streamSSE(c, async (stream) => {
          let requestCleanup: () => void = () => {};
          stream.onAbort(() => requestCleanup());
          await stream.write(": connected\n\n");
          if (stream.aborted) return;
          // dev の Vite プロキシは upstream が落ちても接続を閉じないため、クライアントは無音で切断を
          // 検知する。コメント行 (`:`) は EventSource のイベントにならず見えないので可視イベントで送る。
          // id を付けないので Last-Event-ID (差分再開のカーソル) は動かない
          const ping = () => stream.writeSSE({ event: "ping", data: "{}" });
          void ping();
          const unsubscribe = store.subscribe(
            record,
            after,
            (entry) => {
              void stream.writeSSE({
                // 世代を含める。再起動で seq が戻っても、古いタブのカーソルを resync へ寄せられる
                id: `${record.generation}:${entry.seq}`,
                event: entry.type,
                data: JSON.stringify(entry.data),
              });
            },
            () => requestCleanup(),
          );
          const heartbeat = setInterval(() => void ping(), SSE_HEARTBEAT_MS);
          heartbeat.unref?.();
          // 切断 (onAbort) と store の close のどちらからでも同じ後始末を通す。
          await new Promise<void>((resolveCleanup) => {
            requestCleanup = () => {
              clearInterval(heartbeat);
              unsubscribe();
              resolveCleanup();
            };
          });
        }),
      );
    },
  };
}
