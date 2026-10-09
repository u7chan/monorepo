import { useState } from "react";
import {
  deleteContentKeyConfirmRequest,
  imageCatalogNotice,
  contentKeyStatusBadge,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  contentProviderId,
  contentProviderLabel,
  keyDraftAfterSave,
  speechCatalogNotice,
  speechModelOptions,
  speechModelValue,
  speechSelection,
  speechSaveDisabled,
  speechVoiceDraft,
  speechVoiceMode,
  type ContentSavingAction,
} from "../../lib/contentSettings";
import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import type { ContentSettingsResponse, UpdateContentImageBody, UpdateContentSpeechBody } from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";
import { CheckIcon, TrashIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";
import { useConfirm } from "../ConfirmProvider";
import { ProviderIcon } from "../ProviderIcon";
import { SelectField } from "../SelectField";
import { MetaChip } from "./MetaChip";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type ContentSettingsTabProps = {
  settings: ContentSettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: ContentSavingAction | null;
  onSaveKey: (apiKey: string) => Promise<boolean>;
  onDeleteKey: () => Promise<boolean>;
  onSaveSelection: (input: UpdateContentImageBody) => Promise<boolean>;
  /** 画像モデル一覧の再取得。失敗しても一覧は前のまま残る */
  onRefreshCatalog: () => Promise<boolean>;
  onSaveSpeech: (input: UpdateContentSpeechBody) => Promise<boolean>;
  /** 音声モデル一覧の再取得。失敗しても一覧は前のまま残る */
  onRefreshSpeechCatalog: () => Promise<boolean>;
  /** 音声の表示が server の実効値と一致しているか。false の間は保存を止める */
  speechSynced: boolean;
};

/**
 * 「コンテンツ生成」タブ。キー登録・モデル選択・削除の最小 UI に絞り、未設定ではキー入力だけを出す。
 * `PUT /api/settings/content/image` と `.../speech` は行が無いと 400 のため、モデル選択はキー保存に成功してから現れる。
 * APIキーは画像と音声で 1 つ共有する（音声だけを無効にするトグルは持たない）。
 */
export function ContentSettingsTab({
  settings,
  saving,
  onSaveKey,
  onDeleteKey,
  onSaveSelection,
  onRefreshCatalog,
  onSaveSpeech,
  onRefreshSpeechCatalog,
  speechSynced,
}: ContentSettingsTabProps) {
  // 保存したキーは再表示しないため、入力は常に空から始め、保存できたときだけ消す
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState("");
  const busy = saving !== null;
  const runtimeAvailable = settings.runtimeAvailable;
  const providerName = contentProviderLabel(settings.provider);

  const submitKey = async () => {
    setApiKey(keyDraftAfterSave(apiKey, await onSaveKey(apiKey)));
  };

  const removeKey = async () => {
    if (!(await confirm(deleteContentKeyConfirmRequest(providerName)))) return;
    // 削除できたときだけ入力を捨てる (失敗時に打ちかけの値を消さない)
    if (await onDeleteKey()) setApiKey("");
  };

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {/* このタブがどの provider の設定かを最初に示す。provider が増えたら settings.provider に追随する。
            件数と一覧の出どころはプロバイダータブと同じチップで揃える */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <ProviderIcon provider={contentProviderId(settings.provider)} name={providerName} variant="heading" />
          <h2 className="text-md font-semibold text-ink-strong">{providerName}</h2>
          <code className="text-2xs text-ink-ghost">{contentProviderId(settings.provider)}</code>
          <ProviderBadgeTag badge={contentKeyStatusBadge(settings.configured)} />
          <MetaChip>カタログ {settings.image.models.length}</MetaChip>
          <MetaChip>音声 {settings.speech.models.length}</MetaChip>
        </section>
        {runtimeAvailable ? null : (
          <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
            ランタイムが利用できないため、コンテンツ生成のAPIキーの登録・上書き・削除はできません。サーバーの起動ログを確認してください。
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
                placeholder={
                  settings.configured ? "新しいコンテンツ生成のAPIキー（上書き）" : "コンテンツ生成のAPIキー"
                }
                aria-label="コンテンツ生成のAPIキー"
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
            {providerName} のコンテンツ生成（画像 /
            音声）で共有するキーです。プロバイダータブで登録したキーとは別に管理し、 流用しません。キーは{" "}
            {API_KEY_MIN_LENGTH} 文字以上で入力します。
          </p>
        </section>

        {/* 行が消えると unmount するため、未保存の選択は未設定へ戻った時点で捨てる */}
        {settings.configured ? (
          <>
            <ImageModelSection
              settings={settings}
              busy={busy}
              refreshing={saving === "catalog"}
              onSave={onSaveSelection}
              onRefresh={onRefreshCatalog}
            />
            <SpeechSection
              settings={settings}
              busy={busy}
              synced={speechSynced}
              refreshing={saving === "speech-catalog"}
              onSave={onSaveSpeech}
              onRefresh={onRefreshSpeechCatalog}
            />
          </>
        ) : null}

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>
            保存したキーは<strong>新しい会話</strong>
            から使えます（ツール一覧はセッション作成時に固定されます）。削除しても既存の会話にはツールが残り、実行時にキー無効エラーになります。
          </p>
          <p>
            生成物はセッションの作業フォルダの <code>generated/</code> に保存され、チャットの画像 /
            音声としてプレビューできます。
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
  settings: ContentSettingsResponse;
  busy: boolean;
  refreshing: boolean;
  onSave: (input: UpdateContentImageBody) => Promise<boolean>;
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
          aria-label="コンテンツ生成のモデル"
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
          <MetaChip wrap tone={settings.image.catalogSource === "live" ? "muted" : "warn"}>
            {imageCatalogNotice(settings.image)}
          </MetaChip>
        </p>
        <ReloadButton disabled={busy} onClick={() => void onRefresh()}>
          {refreshing ? "取得中" : "再取得"}
        </ReloadButton>
      </div>
    </section>
  );
}

/**
 * 音声のモデルとボイス。画像と同じ行（`content_settings`）の別の列で、生成のたびにツールが読み直す。
 * 宣言が無いモデルは空欄を許し、自由記述の入力欄へ切り替える（送らない場合は空のまま保存する）。
 */
function SpeechSection({
  settings,
  busy,
  synced,
  refreshing,
  onSave,
  onRefresh,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  synced: boolean;
  refreshing: boolean;
  onSave: (input: UpdateContentSpeechBody) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
}) {
  // null は保存値へ追随する。保存できたら null へ戻し、次の保存値で選択を描き直す
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftVoice, setDraftVoice] = useState<string | null>(null);
  const options = speechModelOptions(settings);
  const savedModel = speechModelValue(settings);
  const savedVoice = settings.speech.voice;
  const selectedModel = draftModel ?? savedModel;
  const selectedOption = options.find((option) => option.value === selectedModel);
  const textMode = speechVoiceMode(selectedOption) === "text";
  // モデルを切り替えたら、ボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せる
  const selectedVoice = speechVoiceDraft({
    draft: draftVoice,
    modelChanged: draftModel !== null,
    option: selectedOption,
    savedVoice,
  });
  const dirty = selectedModel !== savedModel || selectedVoice !== savedVoice;

  const submit = async () => {
    if (!synced) return;
    const input = speechSelection(options, selectedModel, selectedVoice);
    if (!input) return;
    if (await onSave(input)) {
      setDraftModel(null);
      setDraftVoice(null);
    }
  };

  return (
    <section className="grid gap-1.5 border-t border-line pt-3">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">音声（TTS）</div>
      {/* 同期できていない間は、旧い表示を現在値として見せない（保存も speechSaveDisabled が止める） */}
      {synced ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          サーバーから現在の設定を取得できなかったため、表示しているモデルとボイスが最新とは限りません。再読み込みするまで保存できません。
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SelectField
          wrapperClassName="min-w-0 flex-1"
          aria-label="音声生成のモデル"
          value={synced ? selectedModel : ""}
          disabled={busy || !synced}
          onChange={(event) => {
            setDraftModel(event.currentTarget.value);
            setDraftVoice(null);
          }}
        >
          {synced ? null : <option value="">（未確認）</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {textMode ? (
          <input
            className="field min-w-0 flex-1 text-xs"
            value={synced ? selectedVoice : ""}
            aria-label="音声生成のボイス"
            placeholder={synced ? "モデル既定（空欄のまま送ります）" : "（未確認）"}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || !synced}
            onChange={(event) => setDraftVoice(event.currentTarget.value)}
          />
        ) : (
          <SelectField
            wrapperClassName="min-w-0 flex-1"
            aria-label="音声生成のボイス"
            value={synced ? selectedVoice : ""}
            disabled={busy || !synced}
            onChange={(event) => setDraftVoice(event.currentTarget.value)}
          >
            {synced ? null : <option value="">（未確認）</option>}
            {(selectedOption?.model?.voices ?? []).map((voice) => (
              <option key={voice} value={voice}>
                {voice}
              </option>
            ))}
          </SelectField>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={speechSaveDisabled({ busy, synced, dirty })}
          onClick={() => void submit()}
        >
          <CheckIcon />
          保存
        </button>
      </div>
      {/* 演技指示は `instructions` の非ゴールに合わせて渡さない。長文は分割がエージェントの仕事 */}
      <p className="text-2xs leading-relaxed text-ink-muted">
        出力は mp3 固定です。読み上げる文章だけを渡し、演技指示は本文に書かせません。長文は分けて複数回呼ばせます。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* 段落のセマンティクスを残すため、チップ (span) は <p> の中に置く */}
        <p className="min-w-0">
          <MetaChip wrap tone={settings.speech.catalogSource === "live" ? "muted" : "warn"}>
            {speechCatalogNotice(settings.speech)}
          </MetaChip>
        </p>
        <ReloadButton disabled={busy} onClick={() => void onRefresh()}>
          {refreshing ? "取得中" : "再取得"}
        </ReloadButton>
      </div>
    </section>
  );
}

/** キーが平文で保存されることと、BFF を公開しない注意。詳細の上部に既定で畳んで出す */
function SecurityNotice() {
  return (
    <CollapsibleNotice summary="キーは平文で保存されます。ログインがないため公開しないでください。">
      <p>
        登録したキーはアプリのデータベース（SQLite）へ平文で保存され、再起動後も使われます。保存したキーは再表示しません。
      </p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。生成に失敗したときは、キーの誤りや残高不足の可能性があります。</p>
    </CollapsibleNotice>
  );
}
