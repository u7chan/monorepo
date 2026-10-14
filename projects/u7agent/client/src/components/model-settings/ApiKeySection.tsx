import { useEffect, useRef } from "react";
import {
  deleteConfirmRequest,
  MEMO_MAX_LENGTH,
  providerDraftOf,
  resyncAvailable,
  type ProviderDraft,
} from "../../lib/modelSettings";
import type { ProviderAuthSetting } from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { CheckIcon, TrashIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";

export type ApiKeySectionProps = {
  provider: ProviderAuthSetting;
  runtimeAvailable: boolean;
  /** この provider の変更が進行中 (保存 / 削除 / 再同期) */
  saving: boolean;
  /** いずれかの provider の変更が進行中 */
  busy: boolean;
  /** 見出しを出すか。認証方法のタブの中ではタブ名が同じ役割を持つ */
  heading?: boolean;
  drafts: Record<string, ProviderDraft>;
  onChangeDraft: (provider: string, patch: Partial<ProviderDraft>) => void;
  onSave: (provider: string, apiKey: string) => Promise<boolean>;
  onSaveMemo: (provider: string, memo: string) => Promise<boolean>;
  onDelete: (provider: string) => Promise<boolean>;
  onResync: (provider: string) => Promise<boolean>;
};

/**
 * プロバイダー詳細の「APIキー」経路。キーの登録・上書き・削除・再同期と、人間用のメモを持つ。
 * 入力値は親が持つ下書き (provider 単位) から取り、この要素の再マウントで失わない。
 */
export function ApiKeySection({
  provider,
  runtimeAvailable,
  saving,
  busy,
  heading = true,
  drafts,
  onChangeDraft,
  onSave,
  onSaveMemo,
  onDelete,
  onResync,
}: ApiKeySectionProps) {
  const confirm = useConfirm();
  const draft = providerDraftOf(drafts, provider);
  const { apiKey, memo } = draft;
  const savedMemo = provider.memo ?? "";
  const memoDirty = memo.trim() !== savedMemo;

  // 保存値が変わったときだけ入力値を合わせる (同じ内容の再取得で編集中の下書きを消さない)。
  // mount 直後 (provider 切替) は同期しない。memo だけを更新し、入力中の apiKey を巻き戻さない
  const previousSavedMemo = useRef(savedMemo);
  useEffect(() => {
    if (previousSavedMemo.current === savedMemo) return;
    previousSavedMemo.current = savedMemo;
    onChangeDraft(provider.provider, { memo: savedMemo });
  }, [savedMemo]);

  const submit = async () => {
    // 保存できたときだけ入力を消す。await 中に入力された memo は親の最新値だから、apiKey だけを更新する
    if (await onSave(provider.provider, apiKey)) onChangeDraft(provider.provider, { apiKey: "" });
  };

  const submitMemo = async () => {
    // サーバーが trim して保存するため、成功時は trim 済みの値で入力値を戻して dirty を消す。
    // await 中に入力された apiKey は親の最新値だから、memo だけを更新する
    const trimmed = memo.trim();
    if (await onSaveMemo(provider.provider, trimmed)) onChangeDraft(provider.provider, { memo: trimmed });
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        {heading ? <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">APIキー</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          {provider.canSetApiKey ? (
            <form
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <input
                className="field min-w-0 flex-1 text-xs"
                type="password"
                value={apiKey}
                placeholder={provider.managed ? "新しいAPIキー（上書き）" : "APIキー"}
                aria-label={`${provider.name} のAPIキー`}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onChangeDraft(provider.provider, { apiKey: event.currentTarget.value })}
              />
              <button type="submit" className="btn-primary" disabled={busy || apiKey.length === 0}>
                <CheckIcon />
                {provider.managed ? "上書き保存" : "保存"}
              </button>
            </form>
          ) : (
            <p className="min-w-0 flex-1 text-2xs text-ink-ghost">
              この provider のキーは環境変数や認証ファイルで設定します（この画面からは登録できません）。
            </p>
          )}
          {provider.managed ? (
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  if (!(await confirm(deleteConfirmRequest(provider.name)))) return;
                  void onDelete(provider.provider);
                })();
              }}
            >
              <TrashIcon />
              削除
            </button>
          ) : null}
          {resyncAvailable(provider) ? (
            <ReloadButton disabled={busy} onClick={() => void onResync(provider.provider)}>
              {saving ? "再同期中" : "再同期"}
            </ReloadButton>
          ) : null}
        </div>
        <p className="text-2xs leading-relaxed text-ink-muted">
          キーを保存して「モデルを選ぶ」タブに戻ると、利用可能なモデルが増えることがあります。
        </p>
      </div>

      <div className="grid gap-1.5">
        {/* キー入力とは別の form にして、Enter がキーの保存を走らせないようにする */}
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMemo();
          }}
        >
          <label className="grid gap-1 text-2xs text-ink-soft">
            メモ（キー本体は書かないでください）
            <textarea
              className="field min-h-11 min-w-0 text-xs"
              rows={2}
              maxLength={MEMO_MAX_LENGTH}
              value={memo}
              placeholder="例: 個人アカウントの本番キー（2026-01 発行）"
              aria-label={`${provider.name} のメモ`}
              disabled={!runtimeAvailable}
              onChange={(event) => onChangeDraft(provider.provider, { memo: event.currentTarget.value })}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-warn">{memoDirty ? "メモに未保存の変更があります" : ""}</span>
            <button type="submit" className="btn-primary" disabled={!memoDirty || !runtimeAvailable || busy}>
              <CheckIcon />
              メモを保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
