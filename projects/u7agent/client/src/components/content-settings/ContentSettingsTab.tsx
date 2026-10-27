import { useState } from "react";
import {
  deleteContentKeyConfirmRequest,
  imageCatalogNotice,
  contentKeyErrorNotice,
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
  type SpeechPreviewAudio,
} from "../../lib/contentSettings";
import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import { cn } from "../../lib/cn";
import type { ContentSubsection } from "../../lib/settingsNav";
import type {
  ContentSettingsResponse,
  SpeechPreviewBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";
import { CheckIcon, TrashIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";
import { useConfirm } from "../ConfirmProvider";
import { ProviderIcon } from "../ProviderIcon";
import { SelectField } from "../SelectField";
import { ToggleSwitch } from "../ToggleSwitch";
import { MetaChip } from "../model-settings/MetaChip";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";
import { SpeechPlayground } from "./SpeechPlayground";
import { SpeechVoiceOptions } from "./SpeechVoiceOptions";

export type ContentSettingsTabProps = {
  settings: ContentSettingsResponse;
  /** URL が決める面。既定は画像生成 */
  contentSubsection: ContentSubsection;
  /** 実行中の操作。null なら操作なし */
  saving: ContentSavingAction | null;
  /** 有効 / 無効（画像・音声・BGM 共通の 1 つのトグル）。キーと選択は残したまま止められる */
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  onSaveKey: (apiKey: string) => Promise<boolean>;
  onDeleteKey: () => Promise<boolean>;
  onSaveSelection: (input: UpdateContentImageBody) => Promise<boolean>;
  /** 画像モデル一覧の再取得。失敗しても一覧は前のまま残る */
  onRefreshCatalog: () => Promise<boolean>;
  onSaveSpeech: (input: UpdateContentSpeechBody) => Promise<boolean>;
  /** 音声モデル一覧の再取得。失敗しても一覧は前のまま残る */
  onRefreshSpeechCatalog: () => Promise<boolean>;
  /** お試し再生の要求。設定は変えず、応答の音声と形式だけを返す */
  onPreviewSpeech: (input: SpeechPreviewBody, signal?: AbortSignal) => Promise<SpeechPreviewAudio>;
  /** 音声の表示が server の実効値と一致しているか。false の間は保存を止める */
  speechSynced: boolean;
};

/**
 * 設定 → コンテンツ生成の本文。キー登録・モデル選択・削除の最小 UI に絞り、未設定ではキー入力だけを出す。
 * `PUT /api/settings/content/image` と `.../speech` は行が無いと 400 のため、モデル選択はキー保存に成功してから現れる。
 * APIキーは画像と音声で 1 つ共有する（音声だけを無効にするトグルは持たない）。
 */
export function ContentSettingsTab({
  settings,
  contentSubsection,
  saving,
  onSetEnabled,
  onSaveKey,
  onDeleteKey,
  onSaveSelection,
  onRefreshCatalog,
  onSaveSpeech,
  onRefreshSpeechCatalog,
  onPreviewSpeech,
  speechSynced,
}: ContentSettingsTabProps) {
  // 保存したキーは再表示しないため、入力は常に空から始め、保存できたときだけ消す
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState("");
  // 面の下書きはこの画面が持ち続ける。面をタブで出し分けても unmount しないため、未保存の選択を失わない
  const [imageDraft, setImageDraft] = useState<string | null>(null);
  const [speechDraft, setSpeechDraft] = useState<SpeechDraft>(EMPTY_SPEECH_DRAFT);
  const busy = saving !== null;
  const runtimeAvailable = settings.runtimeAvailable;
  const providerName = contentProviderLabel(settings.provider);
  const keyError = contentKeyErrorNotice(settings);

  // 未設定へ戻ったら下書きを捨てる。面の unmount で消えていた挙動を持ち上げた側で明示的に保つ
  if (!settings.configured && (imageDraft !== null || speechDraft.model !== null || speechDraft.voice !== null)) {
    setImageDraft(null);
    setSpeechDraft(EMPTY_SPEECH_DRAFT);
  }

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
          <ProviderBadgeTag badge={contentKeyStatusBadge(settings.keyStored, settings.keyAvailable)} />
          <MetaChip>画像 {settings.image.models.length}</MetaChip>
          <MetaChip>音声 {settings.speech.models.length}</MetaChip>
        </section>
        {runtimeAvailable ? null : (
          <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
            ランタイムが利用できないため、コンテンツ生成のAPIキーの登録・上書き・削除はできません。サーバーの起動ログを確認してください。
          </p>
        )}
        <SecurityNotice />
        {keyError ? (
          // 未評価 / 復号失敗 / master key 未設定の文言はサーバーが返したものをそのまま出す
          <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
            {keyError}
          </p>
        ) : null}

        {/* 実行時トグルはタブの外に置く。画像・音声・BGM は同じキー / 課金を共有するので 1 つに閉じる */}
        {settings.configured ? (
          <section
            className={cn(
              "grid gap-2 rounded-lg border p-3",
              settings.enabled ? "border-line bg-soft" : "border-warn/50 bg-raised",
            )}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">有効 / 無効</div>
                <p className="mt-0.5 text-xs text-ink">アプリ全体の生成を止めます（画像・音声・BGM で共通）。</p>
              </div>
              <ToggleSwitch
                checked={settings.enabled}
                label={settings.enabled ? "有効" : "無効"}
                disabled={busy}
                onChange={(next) => void onSetEnabled(next)}
              />
            </div>
            <p className="text-2xs leading-relaxed text-ink-muted">
              OFF にすると <code>generate_image</code>・<code>generate_speech</code>・<code>generate_bgm</code>{" "}
              は生成を行わず、固定の文言で失敗します。OFF は保存した瞬間から
              <strong>既存のセッション</strong>にも次の呼び出しから効きます（会話の作り直しもデプロイも 要りません）。ON
              に戻したとき、OFF の間に作った会話にはツールが無いため新しい会話が必要です。 キーと選択は残ります。
            </p>
            {settings.enabled ? null : (
              <p className="rounded border border-line bg-base px-2 py-1.5 text-2xs leading-relaxed text-ink-muted">
                無効の間、モデルへはこの文言だけが返ります:
                <span className="text-ink">{settings.disabledMessage}</span>
              </p>
            )}
          </section>
        ) : null}

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
                placeholder={settings.keyStored ? "新しいコンテンツ生成のAPIキー（上書き）" : "コンテンツ生成のAPIキー"}
                aria-label="コンテンツ生成のAPIキー"
                autoComplete="off"
                spellCheck={false}
                disabled={!runtimeAvailable}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
              <button type="submit" className="btn-primary" disabled={!runtimeAvailable || busy || apiKey.length === 0}>
                <CheckIcon />
                {settings.keyStored ? "上書き保存" : "保存"}
              </button>
            </form>
            {settings.keyStored ? (
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
            {providerName} のコンテンツ生成（画像 / 音声 /
            BGM）で共有するキーです。プロバイダータブで登録したキーとは別に管理し、 流用しません。キーは{" "}
            {API_KEY_MIN_LENGTH} 文字以上で入力します。
          </p>
        </section>

        {/* 未設定では面を出さない現行の分岐を保ち、下書きの破棄は上で行う。面だけをタブで切り替える */}
        {settings.configured ? (
          contentSubsection === "speech" ? (
            <SpeechSection
              settings={settings}
              busy={busy}
              synced={speechSynced}
              enabled={settings.enabled}
              refreshing={saving === "speech-catalog"}
              draft={speechDraft}
              onChangeDraft={setSpeechDraft}
              onSave={onSaveSpeech}
              onRefresh={onRefreshSpeechCatalog}
              onPreview={onPreviewSpeech}
            />
          ) : contentSubsection === "bgm" ? (
            <BgmSection settings={settings} />
          ) : (
            <ImageModelSection
              settings={settings}
              busy={busy}
              refreshing={saving === "catalog"}
              draft={imageDraft}
              onChangeDraft={setImageDraft}
              onSave={onSaveSelection}
              onRefresh={onRefreshCatalog}
            />
          )
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
          <p>
            生成済み画像や添付画像を編集に使うと、その画像は外部の provider
            へ無変換（埋め込みメタデータを含む）で送信されます。
          </p>
        </section>
      </div>
    </div>
  );
}

/** 音声のモデルとボイスの下書き。`null` は保存値へ追随する */
type SpeechDraft = { model: string | null; voice: string | null };

const EMPTY_SPEECH_DRAFT: SpeechDraft = { model: null, voice: null };

function BgmSection({ settings }: { settings: ContentSettingsResponse }) {
  return (
    <section className="grid min-w-0 gap-1.5 border-t border-line pt-3">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">音楽（BGM）</h3>
      <label className="grid min-w-0 gap-1.5 text-2xs text-ink-muted">
        固定モデル（変更不可）
        <input
          className="field min-w-0 text-xs"
          aria-label="BGM生成の固定モデル"
          readOnly
          value={settings.bgm.model ?? ""}
        />
      </label>
      <p className="text-2xs leading-relaxed text-ink-muted">
        モデル仕様では{settings.bgm.expectedDurationSeconds}秒のクリップを{settings.bgm.format.toUpperCase()}
        で生成します（実測の尺ではありません）。生成は課金対象で、プロンプトをOpenRouterと生成プロバイダーへ外部送信します。
      </p>
      <p className="text-2xs leading-relaxed text-ink-muted">
        会話から新しいインストゥルメンタルBGMを依頼してください。ボーカルなし・正確なBPMや尺・シームレスループは保証しません。失敗や中断でも課金される可能性があるため、自動で再生成しません。
      </p>
    </section>
  );
}

/** モデル選択。カタログ外の保存値も「（カタログ外）」として選択肢の先頭に残す */
function ImageModelSection({
  settings,
  busy,
  refreshing,
  draft,
  onChangeDraft,
  onSave,
  onRefresh,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  refreshing: boolean;
  draft: string | null;
  onChangeDraft: (draft: string | null) => void;
  onSave: (input: UpdateContentImageBody) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
}) {
  const options = imageModelOptions(settings);
  const savedModel = imageModelValue(settings);
  const selectedModel = draft ?? savedModel;

  const submit = async () => {
    const input = imageModelSelection(options, selectedModel);
    if (!input) return;
    if (await onSave(input)) onChangeDraft(null);
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
          onChange={(event) => onChangeDraft(event.currentTarget.value)}
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
          {refreshing ? "更新中" : "カタログ更新"}
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
  enabled,
  refreshing,
  draft,
  onChangeDraft,
  onSave,
  onRefresh,
  onPreview,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  synced: boolean;
  /** アプリ全体の有効 / 無効。OFF の間はお試し再生でも課金させない */
  enabled: boolean;
  refreshing: boolean;
  draft: SpeechDraft;
  onChangeDraft: (draft: SpeechDraft) => void;
  onSave: (input: UpdateContentSpeechBody) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
  onPreview: (input: SpeechPreviewBody, signal?: AbortSignal) => Promise<SpeechPreviewAudio>;
}) {
  const options = speechModelOptions(settings);
  const savedModel = speechModelValue(settings);
  const savedVoice = settings.speech.voice;
  const selectedModel = draft.model ?? savedModel;
  const selectedOption = options.find((option) => option.value === selectedModel);
  const textMode = speechVoiceMode(selectedOption) === "text";
  // モデルを切り替えたら、ボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せる
  const selectedVoice = speechVoiceDraft({
    draft: draft.voice,
    modelChanged: draft.model !== null,
    option: selectedOption,
    savedVoice,
  });
  const dirty = selectedModel !== savedModel || selectedVoice !== savedVoice;

  const submit = async () => {
    if (!synced) return;
    const input = speechSelection(options, selectedModel, selectedVoice);
    if (!input) return;
    if (await onSave(input)) onChangeDraft(EMPTY_SPEECH_DRAFT);
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
          onChange={(event) => onChangeDraft({ model: event.currentTarget.value, voice: null })}
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
            onChange={(event) => onChangeDraft({ ...draft, voice: event.currentTarget.value })}
          />
        ) : (
          <SelectField
            wrapperClassName="min-w-0 flex-1"
            aria-label="音声生成のボイス"
            value={synced ? selectedVoice : ""}
            disabled={busy || !synced}
            onChange={(event) => onChangeDraft({ ...draft, voice: event.currentTarget.value })}
          >
            {synced ? null : <option value="">（未確認）</option>}
            <SpeechVoiceOptions modelId={selectedModel} voices={selectedOption?.model?.voices} />
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
        出力形式はモデルに合わせて mp3 / wav
        で保存します。読み上げる文章だけを渡し、演技指示は本文に書かせません。長文は分けて複数回呼ばせます。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* 段落のセマンティクスを残すため、チップ (span) は <p> の中に置く */}
        <p className="min-w-0">
          <MetaChip wrap tone={settings.speech.catalogSource === "live" ? "muted" : "warn"}>
            {speechCatalogNotice(settings.speech)}
          </MetaChip>
        </p>
        <ReloadButton disabled={busy} onClick={() => void onRefresh()}>
          {refreshing ? "更新中" : "カタログ更新"}
        </ReloadButton>
      </div>
      {/* 同期できていない間も、保存値を書き換えずにその場で試せる（保存のゲートを持ち込まない） */}
      <SpeechPlayground settings={settings} enabled={enabled} onPreview={onPreview} />
    </section>
  );
}

/** キーを暗号化して保存することと、BFF を公開しない注意。詳細の上部に既定で畳んで出す */
function SecurityNotice() {
  return (
    <CollapsibleNotice summary="キーは暗号化して保存されます。ログインがないため公開しないでください。">
      <p>
        登録したキーは暗号化してアプリのデータベース（SQLite）へ保存され、再起動後も使われます。保存したキーは再表示しません。
        master key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は、保存済みのキーを使えません。
      </p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。生成に失敗したときは、キーの誤りや残高不足の可能性があります。</p>
    </CollapsibleNotice>
  );
}
