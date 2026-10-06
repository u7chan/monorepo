import { cn } from "../../lib/cn";
import {
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_TOOL_NAME,
  webSearchDataFlowNotice,
  webSearchStatusBadge,
} from "../../lib/webSearchSettings";
import type { WebSearchSettingsResponse } from "../../types";
import { MetaChip } from "./MetaChip";
import { ProviderBadgeTag } from "./ProviderBadgeTag";
import { ProviderIcon } from "../ProviderIcon";
import { ToggleSwitch } from "../ToggleSwitch";

export type WebSearchSettingsTabProps = {
  settings: WebSearchSettingsResponse;
  /** 保存中。null なら操作なし */
  saving: boolean;
  /** トグルの変更。保存できたときだけ true を返し、表示は親の state に追随する */
  onChange: (enabled: boolean) => void;
};

/**
 * 設定 → モデル（Web 検索タブ）。`web_search` の実行時トグル（#1775）と、いま使っている provider を出す。
 * 会話を作り直さないと効かない設定と誤解されないよう、OFF の効果は画面上で明示する。
 */
export function WebSearchSettingsTab({ settings, saving, onChange }: WebSearchSettingsTabProps) {
  const { enabled } = settings;

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <h2 className="text-md font-semibold text-ink-strong">Web 検索</h2>
          <code className="text-2xs text-ink-ghost">{WEB_SEARCH_TOOL_NAME}</code>
          <ProviderBadgeTag badge={webSearchStatusBadge(enabled)} />
          <MetaChip>{WEB_SEARCH_PROVIDER.name}</MetaChip>
        </section>

        {/* 既定は ON。止めたい依存をその場で切るのが目的なので、確認ダイアログは挟まない */}
        <section
          className={cn(
            "grid gap-2 rounded-lg border p-3",
            enabled ? "border-line bg-soft" : "border-warn/50 bg-raised",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">有効 / 無効</div>
              <p className="mt-0.5 text-xs text-ink">アプリ全体の検索を止めます。</p>
            </div>
            <ToggleSwitch checked={enabled} label={enabled ? "有効" : "無効"} disabled={saving} onChange={onChange} />
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">
            OFF にすると <code>{WEB_SEARCH_TOOL_NAME}</code>{" "}
            は検索を行わず、固定の文言で失敗します。効くのは保存した瞬間からで、
            <strong>既存のセッション</strong>にも次の呼び出しから効きます（会話の作り直しもデプロイも要りません）。
          </p>
          {enabled ? null : (
            <p className="rounded border border-line bg-base px-2 py-1.5 text-2xs leading-relaxed text-ink-muted">
              無効の間、モデルへはこの文言だけが返ります:
              <span className="text-ink">{settings.disabledMessage}</span>
            </p>
          )}
        </section>

        <section className="grid gap-1.5">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">検索プロバイダー</div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-soft p-2.5">
            <ProviderIcon provider="exa" name={WEB_SEARCH_PROVIDER.name} />
            <span className="text-xs font-semibold text-ink-strong">{WEB_SEARCH_PROVIDER.name}</span>
            <code className="text-2xs text-ink-ghost">{WEB_SEARCH_PROVIDER.host}</code>
            <MetaChip>キー不要</MetaChip>
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">
            キー登録は不要です。共有の keyless エンドポイントを使い、レート制限は provider の無料枠に従います。 provider
            の切り替えと APIキーの登録は #1776 で扱います。
          </p>
        </section>

        {/* 外部送信は、設定を変える前に読める位置へ常時出す（画像生成タブと同じ作法） */}
        <section className="grid gap-1 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-warn">
          <p>{webSearchDataFlowNotice(enabled)}</p>
          <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
        </section>

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>
            無効の間も <code>{WEB_SEARCH_TOOL_NAME}</code> はツール一覧に残り、モデルが呼ぶと固定の文言で失敗します。
            ツール一覧から外すのは新しい会話にしか効かないため、実行時に拒否します。
          </p>
        </section>
      </div>
    </div>
  );
}
