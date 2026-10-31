import type { Context } from "hono";
import type { PiBff } from "../agent";
import type { CloudflareSettingsService } from "../cloudflare-settings";
import type { ContentSettingsService } from "../content-settings";
import { messageFor } from "../http";
import { SandboxRuntimeError, type SandboxRuntimeDiagnostics } from "../sandbox/client";
import { RUNTIME_MODELS_UNAVAILABLE_MESSAGE, SandboxRuntimeInfoSchema, type RuntimeInUseResponse } from "../schema";
import type { TitleSummarySettingsService } from "../title-summary-settings";
import type { WebSearchSettingsService } from "../web-search-settings";

export function createRuntimeRoutes({
  pi,
  runtimeDiagnostics,
  contentSettings,
  webSearchSettings,
  titleSummarySettings,
  cloudflareSettings,
}: {
  pi: PiBff | null;
  /** 実行環境の診断 (未設定なら not_configured)。workspace クライアントとは別に注入する */
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
  contentSettings: ContentSettingsService;
  webSearchSettings: WebSearchSettingsService;
  titleSummarySettings: TitleSummarySettingsService;
  cloudflareSettings: CloudflareSettingsService;
}) {
  return {
    models: (c: Context) => {
      // カタログを取れなかった回は空のカタログで 200 を返さない (全 provider 未認証と区別できない)
      const catalog = pi?.modelCatalog;
      if (!catalog) return c.json({ error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE }, 503);
      return c.json(catalog);
    },
    /**
     * いま使われるモデルと外部連携。設定の面ごとの API はカタログ (大量のモデル一覧) を含むため、
     * 診断画面はこの読み取り専用の集約だけを使う。カタログ・資格情報は組み立てない。
     */
    inUse: (c: Context) => {
      const content = contentSettings.settings();
      const webSearch = webSearchSettings.settings();
      const title = titleSummarySettings.settings();
      const cloudflare = cloudflareSettings.status();
      const response: RuntimeInUseResponse = {
        title: {
          enabled: title.enabled,
          model: title.model,
          thinkingLevel: title.thinkingLevel,
          effectiveThinkingLevel: title.effectiveThinkingLevel,
          modelAvailable: title.modelAvailable,
        },
        content: {
          configured: content.configured,
          enabled: content.enabled,
          keyAvailable: content.keyAvailable,
          imageModel: content.image.model,
          speechModel: content.speech.model,
          // 空文字は「指定なし」。値として返すと画面がボイス名としてコピーできてしまう
          speechVoice: content.speech.voice === "" ? null : content.speech.voice,
          bgmModel: content.bgm.model,
        },
        webSearch: {
          enabled: webSearch.enabled,
          provider: webSearch.provider,
          host: webSearch.providers.find((provider) => provider.id === webSearch.provider)?.host ?? "",
        },
        cloudflare: {
          configured: cloudflare.configured,
          available: cloudflare.available,
          accountId: cloudflare.accountId,
        },
      };
      return c.json(response);
    },
    /**
     * 実行環境の診断。未接続を含めて常に 200 で返し、UI は state だけで分岐する。
     * URL / トークン / サンドボックスの内部エラーはクライアントへ出さず、詳細はログに限る。
     */
    environment: async (c: Context) => {
      if (!runtimeDiagnostics) return c.json({ state: "not_configured" } as const);
      try {
        const parsed = SandboxRuntimeInfoSchema.safeParse(await runtimeDiagnostics.getRuntimeInfo());
        if (!parsed.success) {
          console.warn(`[u7agent] sandbox runtime info is invalid: ${parsed.error.message}`);
          return c.json({ state: "probe_failed" } as const);
        }
        return c.json({
          state: "connected" as const,
          environment: parsed.data.environment,
          commands: parsed.data.commands,
          landlock: parsed.data.landlock,
        });
      } catch (error) {
        const failure = error instanceof SandboxRuntimeError ? error.failure : "probe_failed";
        console.warn(`[u7agent] sandbox runtime probe failed (${failure}): ${messageFor(error)}`);
        return c.json({ state: failure } as const);
      }
    },
  };
}
