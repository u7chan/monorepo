import { useState } from "react";
import { cn } from "../../lib/cn";
import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import {
  deleteWebSearchKeyConfirmRequest,
  WEB_SEARCH_KEY_PLAINTEXT_NOTE,
  WEB_SEARCH_NO_LOGIN_NOTE,
  WEB_SEARCH_SETTINGS_NOTE,
  WEB_SEARCH_TOOL_NAME,
  webSearchDataFlowNotice,
  webSearchKeyBadge,
  webSearchKeyMissingNotice,
  webSearchProviderDef,
  webSearchProviderOptions,
  webSearchStatusBadge,
  type WebSearchSavingAction,
} from "../../lib/webSearchSettings";
import type { WebSearchProviderId, WebSearchSettingsResponse } from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { KeyIcon, TrashIcon } from "../icons";
import { ProviderIcon } from "../ProviderIcon";
import { SelectMenu, type SelectMenuOption } from "../SelectMenu";
import { ToggleSwitch } from "../ToggleSwitch";
import { MetaChip } from "./MetaChip";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type WebSearchSettingsTabProps = {
  settings: WebSearchSettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: WebSearchSavingAction | null;
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  onSelectProvider: (provider: WebSearchProviderId) => Promise<boolean>;
  onSaveKey: (provider: WebSearchProviderId, apiKey: string) => Promise<boolean>;
  onDeleteKey: (provider: WebSearchProviderId) => Promise<boolean>;
};

/**
 * 設定 → モデル（Web 検索タブ）。有効 / 無効（実行時 OFF スイッチ）と、既定の provider +
 * provider ごとのキーを 1 面にまとめる。
 *
 * provider を選ぶと下の 1 枚がその provider の設定に入れ替わり、選んだ時点で既定が保存される
 * （別の「〜を既定にする」ボタンは置かない）。キーの入力は保存できたときだけ捨て、失敗時は残す。
 */
export function WebSearchSettingsTab({
  settings,
  saving,
  onSetEnabled,
  onSelectProvider,
  onSaveKey,
  onDeleteKey,
}: WebSearchSettingsTabProps) {
  const confirm = useConfirm();
  const { enabled, provider } = settings;
  const providerDef = webSearchProviderDef(settings);
  // 選択中の provider ごとに下書きを持つ。切り替えて戻ったとき、打ちかけの値を失わない
  const [drafts, setDrafts] = useState<Partial<Record<WebSearchProviderId, string>>>({});
  const busy = saving !== null;
  const keyDraft = drafts[provider] ?? "";
  const keyMissing = webSearchKeyMissingNotice(providerDef);
  // 選択肢と欄に provider のロゴを出す (プロバイダーの一覧と同じ見た目にそろえる)
  const providerOptions: SelectMenuOption<WebSearchProviderId>[] = webSearchProviderOptions(settings.providers).map(
    (option) => ({
      ...option,
      leading: <ProviderIcon provider={option.value} name={option.label} variant="field" />,
    }),
  );

  const submitKey = async () => {
    // 保存できたときだけ入力を捨てる (失敗時に打ちかけの値を消さない)
    if (await onSaveKey(provider, keyDraft)) {
      setDrafts((current) => ({ ...current, [provider]: "" }));
    }
  };

  const removeKey = async () => {
    if (!(await confirm(deleteWebSearchKeyConfirmRequest(providerDef.name)))) return;
    if (await onDeleteKey(provider)) {
      setDrafts((current) => ({ ...current, [provider]: "" }));
    }
  };

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {/* 何の設定かと、いま効いている状態を最初に示す。provider は下の選択に追従する */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <h2 className="text-md font-semibold text-ink-strong">Web 検索</h2>
          <code className="text-2xs text-ink-ghost">{WEB_SEARCH_TOOL_NAME}</code>
          <ProviderBadgeTag badge={webSearchStatusBadge(enabled)} />
          <MetaChip>既定 {providerDef.name}</MetaChip>
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
            <ToggleSwitch
              checked={enabled}
              label={enabled ? "有効" : "無効"}
              disabled={busy}
              onChange={(next) => void onSetEnabled(next)}
            />
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

        {/* provider を選んだ時点で既定が変わる (選んでから別のボタンを探させない)。下の 1 枚がその設定に入れ替わる */}
        <section className="grid gap-1.5">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">既定の検索プロバイダー</div>
          <SelectMenu
            label="既定の検索プロバイダー"
            value={provider}
            options={providerOptions}
            note="選んだ時点で既定になり、保存されます。"
            disabled={busy}
            onChange={(next) => void onSelectProvider(next)}
          />
          <p className="text-2xs leading-relaxed text-ink-muted">
            下には選んだ provider の設定を出します。失敗しても他の provider
            へは自動で切り替えません（外部送信先と課金先が暗黙に変わらないように）。
          </p>
        </section>

        <section className="grid gap-1.5 rounded-lg border border-accent/50 bg-soft p-2.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <ProviderIcon provider={providerDef.id} name={providerDef.name} />
            <span className="text-xs font-semibold text-ink-strong">{providerDef.name}</span>
            <code className="text-2xs text-ink-ghost">{providerDef.host}</code>
            <ProviderBadgeTag badge={webSearchKeyBadge(providerDef)} />
          </div>
          {providerDef.keyless ? (
            <p className="text-2xs leading-relaxed text-ink-muted">
              キー登録は不要です。共有の keyless エンドポイントを使い、レート制限は provider の無料枠に従います。
            </p>
          ) : (
            <>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitKey();
                }}
              >
                <input
                  className="field min-w-0 flex-1 text-xs"
                  type="password"
                  value={keyDraft}
                  placeholder={providerDef.configured ? "新しいAPIキー（上書き）" : `${providerDef.name} のAPIキー`}
                  aria-label={`${providerDef.name} のAPIキー`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDrafts((current) => ({ ...current, [provider]: value }));
                  }}
                />
                <button type="submit" className="btn-primary" disabled={busy || keyDraft.length === 0}>
                  <KeyIcon />
                  {providerDef.configured ? "上書き保存" : "保存"}
                </button>
                {providerDef.configured ? (
                  <button type="button" className="btn-quiet" disabled={busy} onClick={() => void removeKey()}>
                    <TrashIcon />
                    削除
                  </button>
                ) : null}
              </form>
              <p className="text-2xs leading-relaxed text-ink-muted">
                {WEB_SEARCH_KEY_PLAINTEXT_NOTE} {API_KEY_MIN_LENGTH} 文字以上で入力します。
              </p>
            </>
          )}
          {keyMissing ? (
            <p role="alert" className="text-2xs leading-relaxed text-warn">
              {keyMissing}
            </p>
          ) : null}
        </section>

        {/* 外部送信とキーの保存は、設定を変える前に読める位置へ常時出す（画像生成タブと同じ作法） */}
        <section className="grid gap-1 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-warn">
          <p>{webSearchDataFlowNotice(providerDef, enabled)}</p>
          {providerDef.keyless ? null : <p>選んだ provider のAPIキーは平文で保存し、保存したキーは再表示しません。</p>}
          <p>{WEB_SEARCH_NO_LOGIN_NOTE}</p>
        </section>

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>{WEB_SEARCH_SETTINGS_NOTE}</p>
          <p>
            無効の間も <code>{WEB_SEARCH_TOOL_NAME}</code> はツール一覧に残り、モデルが呼ぶと固定の文言で失敗します。
            ツール一覧から外すのは新しい会話にしか効かないため、実行時に拒否します。
          </p>
        </section>
      </div>
    </div>
  );
}
