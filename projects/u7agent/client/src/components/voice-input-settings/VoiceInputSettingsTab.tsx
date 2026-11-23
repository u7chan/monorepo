import { useState } from "react";
import { useVoiceInputPlayground } from "../../hooks/useVoiceInputPlayground";
import { cn } from "../../lib/cn";
import { voiceInputFrameDeadlineSupported } from "../../lib/voiceInput/deadline";
import {
  deleteVoiceInputKeyConfirmRequest,
  VOICE_INPUT_DATA_POLICY_URL,
  VOICE_INPUT_KEY_ENCRYPTED_NOTE,
  VOICE_INPUT_MODEL_DOC_URL,
  VOICE_INPUT_NO_LOGIN_NOTE,
  VOICE_INPUT_RETENTION_NOTICE,
  VOICE_INPUT_SETTINGS_NOTE,
  VOICE_INPUT_TEST_NOTICE,
  voiceInputBillingNotice,
  voiceInputKeyBadge,
  voiceInputKeyCanSave,
  voiceInputKeyErrorNotice,
  voiceInputModelNote,
  voiceInputPlaygroundDisabledReason,
  voiceInputRuntimeNotice,
  voiceInputSecureContextNotice,
  voiceInputTestDisabledReason,
  voiceInputTestSummary,
  type VoiceInputSavingAction,
} from "../../lib/voiceInputSettings";
import type { VoiceInputSettingsResponse, VoiceInputTestResponse } from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";
import { useConfirm } from "../ConfirmProvider";
import { ExternalLinkIcon } from "../icons";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";
import { VoiceInputKeySection } from "./VoiceInputKeySection";
import { VoiceInputPlayground } from "./VoiceInputPlayground";

export type VoiceInputSettingsTabProps = {
  settings: VoiceInputSettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: VoiceInputSavingAction | null;
  onSaveKey: (apiKey: string) => Promise<boolean>;
  onDeleteKey: () => Promise<boolean>;
  /** 疎通確認の実行中 */
  testing: boolean;
  /** 直近の疎通確認。設定が変わると消える */
  testOutcome: VoiceInputTestResponse | null;
  onTest: () => void;
};

/**
 * 設定 → 音声入力の本文。キーの状態と登録・変更・削除、固定モデル、課金なしの疎通確認、
 * 録音を 1 回試すプレイグラウンドを 1 面にまとめる。入力欄への挿入は別の Issue で、ここには置かない。
 */
export function VoiceInputSettingsTab({
  settings,
  saving,
  onSaveKey,
  onDeleteKey,
  testing,
  testOutcome,
  onTest,
}: VoiceInputSettingsTabProps) {
  const confirm = useConfirm();
  const playground = useVoiceInputPlayground();
  const [apiKey, setApiKey] = useState("");
  const busy = saving !== null;
  const keyBadge = voiceInputKeyBadge(settings);
  const keyError = voiceInputKeyErrorNotice(settings);
  const runtimeNotice = voiceInputRuntimeNotice(settings);
  // secure context の判定はブラウザの値だけ。SSR の無い画面なので、無い環境は制約なしとして扱う
  const secureContextNotice = voiceInputSecureContextNotice(globalThis.isSecureContext !== false);
  const testDisabledReason = voiceInputTestDisabledReason(settings);
  const canTest = testDisabledReason === undefined && !testing && !busy;
  const playgroundDisabledReason = voiceInputPlaygroundDisabledReason(settings);

  const submitKey = async () => {
    // 保存できたときだけ入力を捨てる (失敗時に打ちかけの値を消さない)
    if (await onSaveKey(apiKey)) setApiKey("");
  };

  const removeKey = async () => {
    if (!(await confirm(deleteVoiceInputKeyConfirmRequest()))) return;
    if (await onDeleteKey()) setApiKey("");
  };

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {/* 何の設定かと、いま効いている状態を最初に示す。モデルは固定なので選択肢を置かない */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <h2 className="text-md font-semibold text-ink-strong">音声入力</h2>
          <code className="text-2xs text-ink-ghost">{settings.model}</code>
          <ProviderBadgeTag badge={keyBadge} />
        </section>

        {/* キーの状態と登録 / 変更 / 削除を同じ帯にまとめる。状態の理由は帯の中に出す */}
        <section
          className={cn(
            "grid gap-2 rounded-lg border p-3",
            settings.keyStored && !settings.keyAvailable ? "border-warn/50 bg-raised" : "border-line bg-soft",
          )}
        >
          <div className="min-w-0">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">OPENAI API キー</div>
            <p className="mt-0.5 text-xs text-ink">
              {settings.keyAvailable
                ? "保存済みのキーを使えます。"
                : settings.keyStored
                  ? "保存済みのキーを利用できません。再登録してください。"
                  : "キーを登録すると音声入力を設定できます。"}
            </p>
          </div>
          <VoiceInputKeySection
            keyStored={settings.keyStored}
            apiKey={apiKey}
            busy={busy}
            runtimeAvailable={settings.runtimeAvailable}
            canSave={voiceInputKeyCanSave(settings, apiKey, busy)}
            onChange={setApiKey}
            onSubmit={submitKey}
            onRemove={removeKey}
          />
          {runtimeNotice === null ? null : (
            <p role="alert" className="text-2xs leading-relaxed text-warn">
              {runtimeNotice}
            </p>
          )}
          {keyError === null ? null : (
            <p role="alert" className="text-2xs leading-relaxed break-words text-warn">
              {keyError}
            </p>
          )}
          <p className="text-2xs leading-relaxed text-ink-muted">{VOICE_INPUT_KEY_ENCRYPTED_NOTE}</p>
        </section>

        {/* 固定モデルは読取専用。何を使うかと公式ページを同じ行に置く */}
        <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル</div>
            <code className="text-xs text-ink-strong">{settings.model}</code>
            <a
              className="link-quiet inline-flex items-center gap-1 text-2xs"
              href={VOICE_INPUT_MODEL_DOC_URL}
              target="_blank"
              rel="noreferrer"
            >
              OpenAI の Realtime の説明
              <ExternalLinkIcon />
            </a>
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">{voiceInputModelNote(settings.model)}</p>
        </section>

        {/* 疎通確認はキーの設定のすぐ下に置き、保存した直後に試せるようにする */}
        <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">疎通確認</div>
              <p className="mt-0.5 text-xs text-ink">キーが OpenAI に受け付けられるかを、課金なしで確かめます。</p>
            </div>
            <button type="button" className="btn-primary" disabled={!canTest} onClick={onTest}>
              {testing ? "確認中…" : "疎通確認"}
            </button>
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">{VOICE_INPUT_TEST_NOTICE}</p>
          {testDisabledReason === undefined ? null : (
            <p role="status" className="text-2xs leading-relaxed text-ink-muted">
              {testDisabledReason}
            </p>
          )}
          {testOutcome === null ? null : (
            <p
              role="status"
              className={cn("text-2xs leading-relaxed break-words", testOutcome.ok ? "text-ok" : "text-warn")}
            >
              {voiceInputTestSummary(testOutcome)}
            </p>
          )}
        </section>

        {/* 録音を 1 回試す面。保存も履歴も持たず、入力欄へは入れない */}
        <VoiceInputPlayground
          model={settings.model}
          disabledReason={playgroundDisabledReason}
          frameDeadlineSupported={voiceInputFrameDeadlineSupported()}
          state={playground.state}
          onStart={playground.start}
          onStop={playground.stop}
          onCancel={playground.cancel}
        />

        {/* 送信先のデータの扱いとログインの注意は、既定で畳んで出す（Web 検索と同じ作法）。
            課金と保存しない範囲はプレイグラウンドの面の上に出しているので、ここでは繰り返さない */}
        <CollapsibleNotice summary="音声の扱い（OpenAI のデータポリシー）と、この GUI にログインが無いことを確認する。">
          <p>{voiceInputBillingNotice(settings.model)}</p>
          <p>{VOICE_INPUT_RETENTION_NOTICE}</p>
          <p>
            音声の扱いは{" "}
            <a
              className="link-quiet inline-flex items-center gap-1"
              href={VOICE_INPUT_DATA_POLICY_URL}
              target="_blank"
              rel="noreferrer"
            >
              OpenAI のデータの取り扱い
              <ExternalLinkIcon />
            </a>{" "}
            に従います。
          </p>
          {secureContextNotice === null ? null : <p>{secureContextNotice}</p>}
          <p>{VOICE_INPUT_NO_LOGIN_NOTE}</p>
        </CollapsibleNotice>

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>{VOICE_INPUT_SETTINGS_NOTE}</p>
        </section>
      </div>
    </div>
  );
}
