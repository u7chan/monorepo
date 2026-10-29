import type { Context } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { streamSSE } from "hono/streaming";
import { MAX_ATTACHMENT_BYTES, composePrompt, normalizeAttachmentPaths, toAttachmentPath } from "../attachments";
import { rawLogFileName } from "../diagnostics";
import { workspaceAbs } from "../app-paths";
import { httpError, sandboxFailure, sandboxNotConfigured } from "../http";
import { HISTORY_PAGE_LIMIT_MAX, type HistoryPageResult } from "../history-projection";
import { isValidEntryName } from "../sandbox/protocol";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../sandbox/client";
import { allowsNaturalInvocation } from "../agents";
import { expandSkillCommand, hasProjectSkills, listSessionSkills, type SessionSkillsInput } from "../session-skills";
import { titleSkillCommandRecognized } from "../session-title";
import { resolveAgentSkills } from "../sessions";
import type { SpaceStore } from "../spaces";
import {
  FileUploadSchema,
  type AnswerQuestionBody,
  type CreateSessionBody,
  type ForkSessionBody,
  type MoveSessionBody,
  type PostMessageBody,
  type UpdateSessionNotifyBody,
  type UpdateSessionPinnedBody,
  type UpdateSessionSettingsBody,
  type UpdateSessionTitleBody,
} from "../schema";
import type { SessionRecord, SessionStore } from "../sessions";
import type { ServeService } from "../serve";

// sessions 側の上限とは別 (HTTP 層の契約)
const MAX_MESSAGE_CHARS = 20_000;
const SSE_HEARTBEAT_MS = 15_000;
/** 生ログが無いときの 404。UI はこの文言をそのまま出し、ダウンロードを押せないままにする */
export const RAW_LOG_MISSING_MESSAGE = "この会話の記録は保存されていないため、生ログは取れません。";

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
  serve,
}: {
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  spaces: SpaceStore;
  serve: ServeService;
}) {
  // 未ロードのセッションはストアから復元する (SDK ロードを含むため非同期)
  const resolveRecord = (c: Context) => store.resolve(c.req.param("id") ?? "");

  /**
   * 受理応答の前に、引き継ぎの消費済み印の保存を待つ。失敗していれば 202 を返さず、他の保存失敗と
   * 同じ 500 で理由を返す (印が未保存のまま成功を返すと、再起動でチップが戻る)。
   */
  const awaitHandoffSave = async (saving: Promise<string | undefined> | undefined): Promise<void> => {
    const failure = await saving;
    if (failure) throw httpError(500, `セッションの保存に失敗しました: ${failure}`);
  };

  /** セッションのスキル解決に渡す入力。ファイルスキルはサンドボックス未設定なら落とす */
  const skillsInputOf = (record: SessionRecord): SessionSkillsInput => ({
    rootCwd: store.rootCwd,
    relativeCwd: record.workdir,
    client: workspace ?? undefined,
    // 作成時に固定したエージェントのスナップショットから渡す (定義編集を遡及させない)
    commonSkillNames: record.agent.commonSkillNames,
    builtinSkillNames: record.agent.builtinSkillNames,
    // ビルトインは旧スナップショットに値が無くても常に手動専用にする
    allowNaturalInvocation: allowsNaturalInvocation(record.agent),
  });

  const stop = async (c: Context) => {
    const record = await resolveRecord(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    const result = await store.stop(record);
    return c.json({ sessionId: record.id, ...result });
  };

  return {
    /**
     * 一覧。`scope=all` は全スペースの会話を返し、省略時は従来どおり `spaceId` (既定 default) で絞る。
     * 全スペース一覧も既存の summary 計算の使い回しで、絞り込みを外すだけ。
     */
    list: (c: Context) => {
      const allSpaces = c.req.query("scope") === "all";
      return c.json({ sessions: store.list(allSpaces ? undefined : (c.req.query("spaceId") ?? "default")) });
    },

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
     * 会話メニューからの AI 要約の再実行。生成を待って現在のタイトルと試行を返す。
     * 生成に失敗しても 200 で試行 (failed) を返し、画面が理由を出せるようにする。
     */
    summarizeTitle: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const result = await store.manualSummarizeTitle(record);
      return c.json({ sessionId: record.id, ...result });
    },

    /**
     * 会話の引き継ぎ (引っ越しの拡張)。エージェントとスペースを選び直し、履歴は破棄され、
     * 作業フォルダ / 添付 / cwd キーの行は移動先へ移る。同一スペースへの引き継ぎも許し、
     * プロジェクト所属は同一スペースだけを許す。移動先の検証はスペース側の規則 (未知は 404) に任せ、
     * 要求元の照合は `sessionSpaceGuard` が済ませている。
     */
    move: async (c: Context, body: MoveSessionBody) => {
      const result = await store.move(c.req.param("id") ?? "", spaces.require(body.spaceId), {
        ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
        memo: body.memo === true,
      });
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    /**
     * 会話の分岐。親の現在の末尾までのコンテキストを持つ別の会話を作り、子の payload を返す。
     * 親の履歴・未送信・タイトル・ピン・通知は変えず、作業フォルダ / 添付は共有する。
     * 要求元スペースの照合は `sessionSpaceGuard` が済ませているが、待機の後で親の所属を再確認する
     * (待つ前の照合は引っ越し中の会話で古くなり得る)。
     */
    fork: async (c: Context, body: ForkSessionBody) => {
      const spaceId = spaces.require(c.req.query("spaceId"));
      // 復元 (未所属のスクラッチの mkdir) より先に親のフォルダを確かめる。後から確かめると、
      // 未ロードの親では `load` が空のスクラッチを作ってしまい「フォルダが無い」を隠す
      await store.requireForkWorkdir(c.req.param("id") ?? "");
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      if ((store.spaceOfId(record.id) ?? "default") !== spaceId) return c.json({ error: "Session not found" }, 404);
      // 未指定は親のスナップショットを維持する (undefined を渡しても同じ)
      const child = await store.fork(record, { ...body });
      return c.json(store.payload(child), 201);
    },

    remove: async (c: Context) => {
      // 未ロードでも消せる (SDK を開かない。履歴だけ削除し、作業フォルダは残す)
      const id = c.req.param("id") ?? "";
      const deleted = await store.deleteSession(id);
      if (!deleted) return c.json({ error: "Session not found" }, 404);
      // 回収は削除の成否を変えない (失敗は warn だけ。残った待受はユーザーが回収できる)
      await serve.discardDebug(id);
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
     * セッションで使えるスキル (プロジェクト / 共通 / 組み込み)。
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
      const { agentInfo } = resolveAgentSkills(store.catalog, c.req.query("agentId") || undefined);
      // 作成と同じ前提条件 (永続化あり × プロジェクト選択) を確認し、出した一覧がそのまま送れるようにする
      if (project) await store.requireProjectDir(project.cwd);
      const relativeCwd = project?.cwd ?? "";
      try {
        const skills = await listSessionSkills({
          rootCwd: store.rootCwd,
          relativeCwd,
          client: workspace,
          // セッション作成と同じ選択を反映する (新規チャットのピッカーと作成後の一覧を一致させる)
          commonSkillNames: agentInfo.commonSkillNames,
          builtinSkillNames: agentInfo.builtinSkillNames,
          allowNaturalInvocation: allowsNaturalInvocation(agentInfo),
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
      if (body.resendSendId !== undefined && body.resendRunId !== undefined) {
        return c.json({ error: "resendSendId と resendRunId は同時に指定できません" }, 400);
      }
      const resendSendId = body.resendSendId ?? body.resendRunId;
      if (resendSendId !== undefined) {
        const result = store.resend(record, resendSendId);
        if (!result) return c.json({ error: "この送信は再開できません（保存済みか破棄済みです）" }, 409);
        const { handoffSaving, ...rest } = result;
        await awaitHandoffSave(handoffSaving);
        return c.json({ sessionId: record.id, status: store.statusOf(record), ...rest }, 202);
      }
      const attachments = normalizeAttachmentPaths(body.attachments, store.uploadsOf(record));
      const text = (body.text ?? "").trim();
      // 本文が空でも添付だけで送れる (注記だけのプロンプトになる)
      if (!text && attachments.length === 0) return c.json({ error: "text is required" }, 400);
      if (text.length > MAX_MESSAGE_CHARS) {
        return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 413);
      }
      // タイトル用の入力は本文の部分集合なので、本文と同じ上限で受ける
      if ((body.titleSource ?? "").length > MAX_MESSAGE_CHARS) {
        return c.json({ error: `titleSource is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 413);
      }
      // SDK の /skill: 展開は BFF プロセスの readFileSync で動くため、Docker ではファイル / 組み込みの
      // どちらも展開できない。アプリ側で本文を取り直してから prompt() へ渡す (docs/api-sessions.md)。
      const prompt = await expandSkillCommand(text, skillsInputOf(record));
      // タイトルの元は、定型プロンプトを結合する前の本文 (無ければ送信本文)
      const titleSource = body.titleSource ?? text;
      // 実行 (またはキュー位置) は SessionStore がバックグラウンドで進めるため即座に返す。
      // 注記は履歴とモデルへ渡すためここで合成し、title は注記と展開結果を除いた本文から作る。
      // 保存先はプロジェクトの外にあるため、モデルへは絶対パスで知らせる
      const result = store.postMessage(
        record,
        composePrompt(
          prompt,
          attachments.map((path) => workspaceAbs(store.rootCwd, path)),
        ),
        // 展開後の本文でタイトルを作ると `<skill …>` が並ぶので、ユーザーが打った本文を使う。
        // 定型プロンプトの結合前の本文が届いていれば、それを優先する (タイトルから固定文を除く)。
        // スキル参照は、タイトル用の文字列そのものが実際に展開されたときだけ外す (未知の `/skill:` や、
        // 定型プロンプト側の別スキルの展開結果を流用しない)
        {
          titleSource: titleSource,
          skillCommandRecognized: titleSkillCommandRecognized({
            titleSource,
            sentText: text,
            expandedText: prompt,
          }),
        },
      );
      // 引き継ぎのチップの消費済み印は、受理応答を返す前に保存の成功を確かめる
      const { handoffSaving, ...rest } = result;
      await awaitHandoffSave(handoffSaving);
      return c.json({ sessionId: record.id, status: store.statusOf(record), ...rest }, 202);
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
     * 未送信メッセージの破棄。配送中 / 実行中 / 注入済みの分は消せず 409、記録が無い (別タブで
     * 再送済み / 破棄済み) は 404。末尾の ID は送信ID。
     */
    discardUnsent: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const result = store.discardUnsent(record, c.req.param("sendId") ?? "");
      if (result === "missing") return c.json({ error: "未送信のメッセージが見つかりません" }, 404);
      if (result === "running") return c.json({ error: "再送が実行中のため破棄できません" }, 409);
      return c.json({ ok: true });
    },

    /**
     * 待機中の 1 件だけの取り消し。実行中のターンは止めず、記録 (本文) も残して未送信へ落とす。
     * SDK が実キューから取り出した後 / 実行中の開始送信は状態が変わっているため 409 で断る。
     * 末尾の ID は送信ID。
     */
    cancelQueued: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const result = await store.cancelQueued(record, c.req.param("sendId") ?? "");
      if (result === "running") return c.json({ error: "SDK が取り出したため取り消せません" }, 409);
      if (result === "unstorable") return c.json({ error: "送信の記録を保存できないため取り消せません" }, 409);
      if (result === "missing") return c.json({ error: "待機中のメッセージが見つかりません" }, 404);
      return c.json({ ok: true });
    },

    /**
     * 選択時の即時アップロード。bodyGuard (既定 64 KiB 上限 / text 化) を通さないよう、app.ts では
     * このルートを bodyGuard より先に登録する。保存先は所属スペースの添付置き場 (app-paths.ts の
     * `sessionUploadsRel`。プロジェクトのリポジトリ内にファイルを作らない)。分岐した子は親の置き場を
     * 共有するため、保存先は `store.uploadsOf` が決める。
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
      const uploadsDirRel = store.uploadsOf(record);
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

    /**
     * 不具合の切り分け用のダンプ。状態の要約と、mask 済みの直近イベント (上限つき) を返す。
     * 未ロードの会話は SDK を開かず、保存済みメタだけを返す (壊れた JSONL でも取れる)。
     */
    diagnostics: async (c: Context) => {
      const result = await store.diagnosticsOf(c.req.param("id") ?? "");
      if (!result) return c.json({ error: "Session not found" }, 404);
      return c.json(result);
    },

    /**
     * 生ログ (session.jsonl) のダウンロード。**mask 前**の値が入るため、開示の確認は UI が取る。
     * サイズは既存のセッションファイルの扱いと同じく上限を設けず、ストリームで返す。
     */
    rawLog: async (c: Context) => {
      const id = c.req.param("id") ?? "";
      const raw = await store.rawLogOfId(id);
      if (raw.state === "unknown") return c.json({ error: "Session not found" }, 404);
      if (raw.state === "missing") return c.json({ error: RAW_LOG_MISSING_MESSAGE }, 404);
      const stream = Readable.toWeb(createReadStream(raw.path)) as ReadableStream<Uint8Array>;
      return c.body(stream, 200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Length": String(raw.bytes),
        "Content-Disposition": `attachment; filename="${rawLogFileName(id, Date.now())}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
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
