import type { Context } from "hono";
import { parseByteRange } from "../byte-range";
import type { ContentSettingsService, ContentMutationOutcome } from "../content-settings";
import type { ContentTrialsService } from "../content-trials";
import type {
  CreateContentTrialBody,
  UpdateContentEnabledBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../schema";

/**
 * 設定 → コンテンツ生成の provider / model / APIキー / 有効無効 API。GET は純粋読取、
 * 変更系（PUT / DELETE）は 200 の応答に必ず `state: "applied"` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 * 設定を変えない生成は試行（`POST /trials`）に一本化し、別の生成ルートを持たない。
 */
export function createContentSettingsRoutes({
  contentSettings,
  contentTrials,
}: {
  contentSettings: ContentSettingsService;
  contentTrials: ContentTrialsService;
}) {
  return {
    list: (c: Context) => c.json(contentSettings.settings()),

    // トグルは画像・音声・BGM で共通（行の enabled 1 列）。サブリソースは provider / model / キーだけにする
    putEnabled: async (c: Context, body: UpdateContentEnabledBody) =>
      respond(c, await contentSettings.putEnabled(body.enabled)),

    putSelection: async (c: Context, body: UpdateContentImageBody) =>
      respond(c, await contentSettings.putSelection(body)),

    putSpeechSelection: async (c: Context, body: UpdateContentSpeechBody) =>
      respond(c, await contentSettings.putSpeechSelection(body)),

    putKey: async (c: Context, apiKey: string) => respond(c, await contentSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respond(c, await contentSettings.deleteKey()),

    // 取得できなくても 200。一覧を失わせず、失敗は catalogError だけに載せる（DB のガードも通さない）
    refreshCatalog: async (c: Context) => c.json(await contentSettings.refreshCatalog()),

    refreshSpeechCatalog: async (c: Context) => c.json(await contentSettings.refreshSpeechCatalog()),

    // 試行は 202 で開始し、状態は GET で取る。画面の寿命にも、リクエストの signal にも結び付けない。
    // 同じ入力の保存済み成功があるときは provider を呼ばず 200 + `reused: true` を返す（課金しない）
    startTrial: (c: Context, body: CreateContentTrialBody) => {
      const outcome = contentTrials.start(body);
      if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
      return c.json({ trial: outcome.trial, reused: outcome.reused }, outcome.status);
    },

    getTrial: (c: Context) => {
      const outcome = contentTrials.get(c.req.param("id") ?? "");
      if (outcome.status !== 200) return c.json({ error: outcome.error }, 404);
      return c.json({ trial: outcome.trial });
    },

    // 既定は全種別。`?kind=` は入力の絞り込みで、未知の種別は空の一覧になる
    listTrials: (c: Context) => {
      const kind = c.req.query("kind");
      const outcome = contentTrials.list(kind === undefined || kind === "" ? undefined : kind);
      return c.json({ items: outcome.items, keyEpoch: outcome.keyEpoch, artifactUsage: outcome.artifactUsage });
    },

    /**
     * 保存済みの成果物。trial id だけで引き、パスは受け取らない。保存時に確定した許可 MIME だけを返し、
     * `nosniff` と `no-store` を付け、`?download=1` のときだけ添付にする。
     * 音声のシークのため、raw 配信と同じ単一 `Range` の契約（200 / 206 / 416）に従う。
     */
    rawTrial: async (c: Context) => {
      const outcome = await contentTrials.raw(c.req.param("id") ?? "");
      if (outcome.status !== 200) return c.json({ error: outcome.error }, 404);
      const size = outcome.bytes.byteLength;
      const base = {
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        ...(c.req.query("download") === "1"
          ? { "Content-Disposition": `attachment; filename="${outcome.fileName}"` }
          : {}),
      };
      const range = parseByteRange(c.req.header("Range"), size);
      if (range.kind === "unsatisfiable") {
        // 416 の本文は JSON のエラーなので、宣言する MIME も成果物のものではなく JSON にする
        // 416 の Content-Range は全体の長さを表す（bytes */<size>）
        return c.json({ error: "要求された範囲を配信できません" }, 416, {
          ...base,
          "Content-Range": `bytes */${size}`,
        });
      }
      if (range.kind === "satisfiable") {
        return new Response(outcome.bytes.slice(range.start, range.end + 1), {
          status: 206,
          headers: {
            ...base,
            "Content-Type": outcome.contentType,
            "Content-Length": String(range.end - range.start + 1),
            "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          },
        });
      }
      return new Response(outcome.bytes, {
        status: 200,
        headers: { ...base, "Content-Type": outcome.contentType, "Content-Length": String(size) },
      });
    },

    // `running` のときだけ受け付ける。終端は 409（状態を戻さない）
    cancelTrial: (c: Context) => {
      const outcome = contentTrials.cancel(c.req.param("id") ?? "");
      if (outcome.status === 404) return c.json({ error: outcome.error }, 404);
      if (outcome.status === 409) return c.json({ error: outcome.error }, 409);
      return c.json({ trial: outcome.trial });
    },

    // 個別削除は終端状態だけ。`running` は 409 で「先に中断してください」を返す。成果物も消す
    removeTrial: async (c: Context) => {
      const outcome = await contentTrials.remove(c.req.param("id") ?? "");
      if (outcome.status === 404) return c.json({ error: outcome.error }, 404);
      if (outcome.status === 409) return c.json({ error: outcome.error }, 409);
      return c.json({ removed: outcome.removed });
    },

    // 全削除も終端状態だけを対象にする（実行中の試行は残す）。その行の成果物も消す
    removeAllTrials: async (c: Context) => {
      const kind = c.req.query("kind");
      const outcome = await contentTrials.removeAll(kind === undefined || kind === "" ? undefined : kind);
      return c.json({ removed: outcome.removed });
    },
  };
}

function respond(c: Context, outcome: ContentMutationOutcome) {
  if (outcome.status === 400) return c.json({ error: outcome.error }, 400);
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
