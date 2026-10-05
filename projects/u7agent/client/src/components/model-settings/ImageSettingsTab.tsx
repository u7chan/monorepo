import { useState } from "react";
import {
  deleteImageKeyConfirmRequest,
  imageCatalogNotice,
  imageKeyStatusBadge,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  imageProviderId,
  imageProviderLabel,
  keyDraftAfterSave,
  type ImageSavingAction,
} from "../../lib/imageSettings";
import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import type { ImageSettingsResponse, UpdateImageSelectionBody } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";
import { useConfirm } from "../ConfirmProvider";
import { ProviderIcon } from "../ProviderIcon";
import { SelectField } from "../SelectField";
import { MetaChip } from "./MetaChip";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type ImageSettingsTabProps = {
  settings: ImageSettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: ImageSavingAction | null;
  onSaveKey: (apiKey: string) => Promise<boolean>;
  onDeleteKey: () => Promise<boolean>;
  onSaveSelection: (input: UpdateImageSelectionBody) => Promise<boolean>;
  /** モデル一覧の再取得。失敗しても一覧は前のまま残る */
  onRefreshCatalog: () => Promise<boolean>;
};

/**
 * 「画像生成」タブ。キー登録・モデル選択・削除の最小 UI に絞り、未設定ではキー入力だけを出す。
 * `PUT /api/settings/images` は行が無いと 400 のため、モデル選択はキー保存に成功してから現れる。
 */
export function ImageSettingsTab({
  settings,
  saving,
  onSaveKey,
  onDeleteKey,
  onSaveSelection,
  onRefreshCatalog,
}: ImageSettingsTabProps) {
  // 保存したキーは再表示しないため、入力は常に空から始め、保存できたときだけ消す
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState("");
  const busy = saving !== null;
  const runtimeAvailable = settings.runtimeAvailable;
  const providerName = imageProviderLabel(settings.provider);

  const submitKey = async () => {
    setApiKey(keyDraftAfterSave(apiKey, await onSaveKey(apiKey)));
  };

  const removeKey = async () => {
    if (!(await confirm(deleteImageKeyConfirmRequest(providerName)))) return;
    // 削除できたときだけ入力を捨てる (失敗時に打ちかけの値を消さない)
    if (await onDeleteKey()) setApiKey("");
  };

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {/* このタブがどの provider の設定かを最初に示す。provider が増えたら settings.provider に追随する。
            件数と一覧の出どころはプロバイダータブと同じチップで揃える */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <ProviderIcon provider={imageProviderId(settings.provider)} name={providerName} variant="heading" />
          <h2 className="font-semibold text-base text-ink-strong">{providerName}</h2>
          <code className="text-2xs text-ink-ghost">{imageProviderId(settings.provider)}</code>
          <ProviderBadgeTag badge={imageKeyStatusBadge(settings.configured)} />
          <MetaChip>カタログ {settings.models.length}</MetaChip>
        </section>
        {runtimeAvailable ? null : (
          <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
            ランタイムが利用できないため、画像APIキーの登録・上書き・削除はできません。サーバーの起動ログを確認してください。
          </p>
        )}
        <SecurityNotice />

        <section className="grid gap-1.5">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">APIキー</div>
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitKey();
              }}
            >
              <input
                className="field min-w-0 flex-1 text-xs"
                type="password"
                value={apiKey}
                placeholder={settings.configured ? "新しい画像APIキー（上書き）" : "画像APIキー"}
                aria-label="画像生成のAPIキー"
                autoComplete="off"
                spellCheck={false}
                disabled={!runtimeAvailable}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
              <button type="submit" className="btn-primary" disabled={!runtimeAvailable || busy || apiKey.length === 0}>
                <CheckIcon />
                {settings.configured ? "上書き保存" : "保存"}
              </button>
            </form>
            {settings.configured ? (
              <button
                type="button"
                className="btn-quiet"
                disabled={!runtimeAvailable || busy}
                onClick={() => void removeKey()}
              >
                <TrashIcon />
                削除
              </button>
            ) : null}
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">
            {providerName} の画像生成専用のキーです。プロバイダータブで登録したキーとは別に管理し、流用しません。 キーは{" "}
            {API_KEY_MIN_LENGTH} 文字以上で入力します。
          </p>
        </section>

        {/* 行が消えると unmount するため、未保存の選択は未設定へ戻った時点で捨てる */}
        {settings.configured ? (
          <ImageModelSection
            settings={settings}
            busy={busy}
            refreshing={saving === "catalog"}
            onSave={onSaveSelection}
            onRefresh={onRefreshCatalog}
          />
        ) : null}

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>
            保存したキーは<strong>新しい会話</strong>
            から使えます（ツール一覧はセッション作成時に固定されます）。削除しても既存の会話にはツールが残り、実行時にキー無効エラーになります。
          </p>
          <p>
            生成物はセッションの作業フォルダの <code>generated/</code> に保存され、チャットの Markdown
            画像としてプレビューできます。
          </p>
        </section>
      </div>
    </div>
  );
}

/** モデル選択。カタログ外の保存値も「（カタログ外）」として選択肢の先頭に残す */
function ImageModelSection({
  settings,
  busy,
  refreshing,
  onSave,
  onRefresh,
}: {
  settings: ImageSettingsResponse;
  busy: boolean;
  refreshing: boolean;
  onSave: (input: UpdateImageSelectionBody) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
}) {
  // null は保存値へ追随する。保存できたら null へ戻し、次の保存値で選択を描き直す
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const options = imageModelOptions(settings);
  const savedModel = imageModelValue(settings);
  const selectedModel = draftModel ?? savedModel;

  const submit = async () => {
    const input = imageModelSelection(options, selectedModel);
    if (!input) return;
    if (await onSave(input)) setDraftModel(null);
  };

  return (
    <section className="grid gap-1.5">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SelectField
          wrapperClassName="min-w-0 flex-1"
          aria-label="画像生成のモデル"
          value={selectedModel}
          disabled={busy}
          onChange={(event) => setDraftModel(event.currentTarget.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || selectedModel === savedModel}
          onClick={() => void submit()}
        >
          <CheckIcon />
          保存
        </button>
      </div>
      {/* サイズ・品質・出力形式の UI は持たない理由だけを残す。provider は見出しに出ている */}
      <p className="text-2xs leading-relaxed text-ink-muted">サイズ・品質・出力形式は provider の既定を使います。</p>
      <div className="flex flex-wrap items-center gap-2">
        {/* 段落のセマンティクスを残すため、チップ (span) は <p> の中に置く */}
        <p className="min-w-0">
          <MetaChip wrap tone={settings.catalogSource === "live" ? "muted" : "warn"}>
            {imageCatalogNotice(settings)}
          </MetaChip>
        </p>
        <ReloadButton disabled={busy} onClick={() => void onRefresh()}>
          {refreshing ? "取得中" : "再取得"}
        </ReloadButton>
      </div>
    </section>
  );
}

/** キーが平文で保存されることと、BFF を公開しない注意。詳細の上部に常時出す */
function SecurityNotice() {
  return (
    <section className="grid gap-1 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-warn">
      <p>
        登録したキーはアプリのデータベース（SQLite）へ平文で保存され、再起動後も使われます。保存したキーは再表示しません。
      </p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。生成に失敗したときは、キーの誤りや残高不足の可能性があります。</p>
    </section>
  );
}
