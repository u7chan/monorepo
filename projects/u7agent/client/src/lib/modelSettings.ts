/**
 * 設定 → モデルの表示変換。コンポーネントから切り出し、認証バッジ・並び・保存後の文言をテストできるようにする。
 * 保存先 (managed = DB) と実効値 (auth.source) と未反映 (degraded) は混ぜず、別々に出す。
 * 案内文 (degradedNotice) は、そのカードで実際に押せる回復操作 (resyncAvailable) と一致させる。
 */
import type {
  ModelMutationResponse,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
} from "../types";

/** サーバーの検証と同じ境界。クライアントでも保存前に同じ理由で止める */
export const API_KEY_MIN_LENGTH = 8;
export const API_KEY_MAX_LENGTH = 2048;

export const MODEL_SETTINGS_NOTE = "登録したキーは保存され、再起動後も使われます。登録済みのキーは再表示しません。";

export type ProviderBadgeTone = "ok" | "muted" | "warn";

export interface ProviderBadge {
  label: string;
  tone: ProviderBadgeTone;
}

/** 認証の出所ラベル。生のラベルや値は出さず、既知の分類だけを日本語にする */
function authSourceLabel(provider: ProviderAuthSetting): string {
  switch (provider.auth.source) {
    case "runtime":
      return "この画面で登録済み（実効）";
    case "environment": {
      const names = provider.auth.environmentVariables;
      return names.length > 0 ? `環境変数（${names.join(", ")}）` : "環境変数";
    }
    case "stored":
      return "保存済み（auth.json）";
    case "models_json_key":
      return "models.json のキー";
    case "models_json_command":
      return "models.json のコマンド";
    case "fallback":
      return "フォールバック";
    default:
      return "認証済み";
  }
}

/**
 * 認証状態のバッジ。未反映 (degraded) とカタログ外を先に見て、保存行の有無だけで「使える」と
 * 見せない。実効の出所は auth.source があればそちらを優先する。
 */
export function providerAuthBadge(provider: ProviderAuthSetting): ProviderBadge {
  if (provider.degraded === "apply") return { label: "保存済み（未反映）", tone: "warn" };
  if (provider.degraded === "remove") return { label: "削除が未反映", tone: "warn" };
  if (provider.orphan) return { label: provider.managed ? "カタログ外（保存済み）" : "カタログ外", tone: "warn" };
  if (provider.auth.configured) return { label: authSourceLabel(provider), tone: "ok" };
  return { label: provider.supportsOAuth ? "未設定（OAuth 可）" : "未設定", tone: "muted" };
}

/**
 * この画面から回復操作 (再同期) を出せるか。UI 外で張られた overlay を消さないため、
 * サーバーはカタログにある provider か degraded が remove の provider だけを受ける。
 */
export function resyncAvailable(provider: ProviderAuthSetting): boolean {
  if (!provider.degraded) return false;
  return !provider.orphan || provider.degraded === "remove";
}

/**
 * degraded の回復案内。このカードで実際に押せる操作だけを案内する ([再同期] を書くなら
 * resyncAvailable() が true であること)。カタログ外の apply は resync API も 400 にするため、
 * 削除かカタログ復帰へ導く。
 */
export function degradedNotice(provider: ProviderAuthSetting): string | undefined {
  if (provider.degraded === "apply") {
    return provider.orphan
      ? "保存済みのキーは実行中のランタイムへ反映できません（現在のカタログに無い provider です）。[削除] で保存を取り消すか、カタログに戻ってから登録し直してください。"
      : "保存済みのキーが実行中のランタイムへ反映されていません。[再同期] を実行するか、次回の変更か再起動で反映されます。";
  }
  if (provider.degraded === "remove") {
    return "保存行は削除済みですが、実行中のランタイムに前のキーが残っている可能性があります。[再同期] で削除を再試行できます。";
  }
  return undefined;
}

export interface ProviderGroups {
  /** 設定済み (認証済み / 保存済み / 利用可能モデルあり) を元の順で先頭に */
  configured: ProviderAuthSetting[];
  unconfigured: ProviderAuthSetting[];
}

export function availableCountOf(catalog: RuntimeModelsResponse | null, provider: string): number {
  const entry = catalog?.providers.find((candidate) => candidate.provider === provider);
  return entry?.models.filter((model) => model.available).length ?? 0;
}

/** 設定済みを先頭に、未設定は畳めるよう後ろへ分ける。並びはサーバーが返した順を保つ */
export function groupProviders(
  settings: ModelsSettingsResponse,
  catalog: RuntimeModelsResponse | null,
): ProviderGroups {
  const groups: ProviderGroups = { configured: [], unconfigured: [] };
  for (const provider of settings.providers) {
    const settled = provider.auth.configured || provider.managed || availableCountOf(catalog, provider.provider) > 0;
    (settled ? groups.configured : groups.unconfigured).push(provider);
  }
  return groups;
}

export function validateApiKey(value: string): string | undefined {
  if (value.length < API_KEY_MIN_LENGTH) return `APIキーは ${API_KEY_MIN_LENGTH} 文字以上で入力してください。`;
  if (value.length > API_KEY_MAX_LENGTH) return `APIキーは ${API_KEY_MAX_LENGTH} 文字以内で入力してください。`;
  return undefined;
}

export type MutationAction = "save" | "delete" | "resync";

/** 削除の確認。既存の会話は自動でモデルを切り替えないため、影響を先に伝える */
export function deleteConfirmMessage(name: string): string {
  return `「${name}」のAPIキーを削除します。以降の送信が認証で失敗することがあり、未ロードの会話は復元時に別のモデルへ切り替わります。環境変数や auth.json の認証があれば、そちらが使われます。`;
}

/** 変更系の応答 (200) を操作の種類に応じた注記へ写す。applied_unsynced は再同期を案内する */
export function mutationNote(
  action: MutationAction,
  response: ModelMutationResponse,
): { text: string; error: boolean } {
  const unsynced = response.state === "applied_unsynced";
  const suffix =
    "保存しましたが、実行中のランタイムへは未反映です。再同期を実行するか、次回の変更か再起動で反映されます。";
  switch (action) {
    case "save":
      return unsynced
        ? { text: `APIキーを${suffix}`, error: true }
        : { text: "APIキーを保存しました。モデル候補を更新しています。", error: false };
    case "delete":
      return unsynced
        ? { text: `削除は${suffix}`, error: true }
        : { text: "この画面で登録したAPIキーを削除しました。", error: false };
    case "resync":
      return unsynced
        ? { text: "再同期できませんでした。時間をおいてもう一度実行してください。", error: true }
        : { text: "再同期しました。モデル候補を更新しています。", error: false };
  }
}
