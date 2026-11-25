/**
 * 設定 → コンテンツ生成の表示変換のうち、画像 / 音声のどちらにも属さないもの（キー・価格の書式・種別をまたぐ注記）。
 * DOM に依存しない純関数だけを置き、確認文・保存後の文言・状態バッジをテストできるようにする。
 */
import type { ContentSettingsResponse } from "../../types";
import type { ConfirmRequest } from "../confirmDialog";
import { messageTimeLabel, type MessageTimeOptions } from "../messageTime";
import type { ProviderBadge } from "../modelSettings";

/** コンテンツ生成の初期注記。キーの有無に関わらず出す */
export const CONTENT_SETTINGS_NOTE = "コンテンツ生成の設定はサーバーに保存され、再起動後も残ります。";

export const CONTENT_KEY_SAVED_NOTE =
  "コンテンツ生成のAPIキーを保存しました。新しい会話から generate_image・generate_speech・generate_bgm を使えます。";
export const CONTENT_KEY_DELETED_NOTE =
  "コンテンツ生成のAPIキーを削除しました。generate_image・generate_speech・generate_bgm は新しい会話から使えません。";
/** コストマスタの保存。取得はしないため「取得した」とは書かない */
export const CONTENT_COST_SAVED_NOTE = "コストマスタの設定を保存しました。価格の取得は [カタログ更新] で行います。";

/** 実行中の操作。null なら操作なし */
export type ContentSavingAction =
  | "enabled"
  | "key"
  | "delete"
  | "provider"
  | "selection"
  | "catalog"
  | "speech"
  | "cost";

/**
 * 有効 / 無効を保存したときの注記。ツール一覧はセッション作成時に固定するため、OFF は既存の会話に
 * 効くが、ON は OFF の間に作った会話には効かない（そこにはツールが無い）ことを書き分ける。
 */
export function contentEnabledNote(enabled: boolean): string {
  return enabled
    ? "コンテンツ生成を有効にしました。ツールを持つ既存の会話では次の呼び出しから generate_image・generate_speech・generate_bgm を使えます（OFF の間に作った会話にはツールが無いため、新しい会話で使えます）。"
    : "コンテンツ生成を無効にしました。既存の会話でも次の呼び出しから固定の文言で失敗します（キーと選択は残ります）。";
}

/**
 * APIキーの登録状態バッジ。`configured`（設定行の有無）ではなく `keyStored`（暗号文の有無）で出し、
 * 保存済みでも復号できないキーを「設定済み」と誤表示しない。同じ意味の表示をプロバイダータブと揃える。
 */
export function contentKeyStatusBadge(keyStored: boolean, keyAvailable = true): ProviderBadge {
  if (!keyStored) return { label: "未設定", tone: "muted" };
  return keyAvailable ? { label: "設定済み", tone: "ok" } : { label: "利用不可", tone: "warn" };
}

/**
 * 保存済みのキーを使えない理由。未評価 / 復号失敗の固定文言はサーバーが返したものをそのまま出し、
 * クライアントで原因を推測しない。
 */
export function contentKeyErrorNotice(
  settings: Pick<ContentSettingsResponse, "keyStored" | "keyAvailable" | "keyErrorMessage">,
): string | null {
  if (!settings.keyStored || settings.keyAvailable) return null;
  return settings.keyErrorMessage;
}

/** 未設定 (行が無い) のときに見せる provider。画像 / 音声で共有し、サーバーが既定行を作る provider と同じにする */
const DEFAULT_CONTENT_PROVIDER = "openrouter";

/** 見出しのロゴを引く id。未設定でも、これから登録するキーの provider を出す */
export function contentProviderId(provider: string | null): string {
  return provider ?? DEFAULT_CONTENT_PROVIDER;
}

/** provider の表示名。v1 は openrouter だけなので id のまま出さず、既知の provider は名前へ寄せる */
export function contentProviderLabel(provider: string | null): string {
  const id = contentProviderId(provider);
  return id === DEFAULT_CONTENT_PROVIDER ? "OpenRouter" : id;
}

/** [カタログ更新] の結果。失敗した系統ごとに、一覧と価格のどちらが変わらないかを伝える */
export function contentCatalogRefreshNote(
  scope: "image" | "speech",
  errors: { image?: string | undefined; speech?: string | undefined; cost?: string | undefined },
): { text: string; error: boolean } {
  const parts: string[] = [];
  if (scope === "image" && errors.image !== undefined) {
    parts.push(`${errors.image}。表示中の一覧は変わりません。`);
  }
  if ((scope === "image" || scope === "speech") && errors.cost !== undefined) {
    parts.push("価格を取得できませんでした。表示中の価格は変わりません。");
  }
  if (scope === "speech" && errors.speech !== undefined) {
    parts.push(`${errors.speech}。表示中の一覧は変わりません。`);
  }
  return parts.length === 0
    ? { text: "モデル一覧を取得しました。", error: false }
    : { text: parts.join(" "), error: true };
}

/** `$0.00` を出さない。不明は `--`、宣言された無料は `$0`。画像と音声の単価表示で同じ書式を使う */
export function formatPriceAmount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value === 0) return "$0";
  const rounded = value >= 1 ? value.toFixed(2) : value.toFixed(4);
  return `$${String(Number(rounded))}`;
}

/** コストマスタの状態。未設定は出さず、停止中（前回取得）と未取得を別の文言にする */
export function costNotice(
  cost: ContentSettingsResponse["cost"],
  options: MessageTimeOptions = {},
): { text: string; tone: "muted" | "warn" } | null {
  if (cost.url === null) return null;
  const at = cost.fetchedAt === null ? "" : `（前回取得: ${messageTimeLabel(cost.fetchedAt, options)}）`;
  if (!cost.enabled) return { text: `コスト表示は停止中${at}`, tone: "warn" };
  if (cost.fetchedAt === null) {
    return { text: "価格はまだ取得していません（[カタログ更新] で取得します）", tone: "warn" };
  }
  return { text: `価格の最終取得: ${messageTimeLabel(cost.fetchedAt, options)}`, tone: "muted" };
}

/** 選択肢の表示名。name が空なら id だけ、同じ name が複数あるときは id を添えて一意にする */
export function optionLabel(entry: { id: string; name: string }, duplicated: boolean): string {
  if (entry.name === "") return entry.id;
  return duplicated ? `${entry.name}（${entry.id}）` : entry.name;
}

/** 表示名の昇順。`localeCompare` はロケール依存を持ち込むため使わず、ASCII の単純比較にする */
export function compareOptionLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** キー入力の後始末。保存できたときだけ空へ戻し、失敗時は再入力を避けて残す */
export function keyDraftAfterSave(draft: string, saved: boolean): string {
  return saved ? "" : draft;
}

/** 削除の確認。新しい会話で使えなくなることと、既存の会話で実行時に失敗することを先に伝える */
export function deleteContentKeyConfirmRequest(providerName: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "コンテンツ生成のAPIキーを削除",
    subject: { label: "対象の provider", value: providerName },
    body: [
      "generate_image・generate_speech・generate_bgm は新しい会話で使えなくなり、既存の会話で実行するとキー無効エラーになります。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
}
