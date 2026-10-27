import { useId, useRef, useState } from "react";
import {
  CUSTOM_PROVIDER_CONTEXT_WINDOW_NOTE,
  CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  CUSTOM_PROVIDER_PROBE_MISSING_NOTE,
  CUSTOM_PROVIDER_PROBE_PENDING_NOTE,
  contextWindowOptions,
  currentCustomProviderProbe,
  customProviderCreateBody,
  customProviderDegradedNotice,
  customProviderDraftOf,
  customProviderEditable,
  customProviderFormHasError,
  customProviderProbeBody,
  customProviderProbeDisplay,
  customProviderProbeEnabled,
  customProviderProbeOutcome,
  customProviderUpdateBody,
  deleteCustomProviderConfirm,
  emptyCustomProviderDraft,
  modelIdMissingFromList,
  validateCustomProviderDraft,
  type CustomProviderFormDraft,
  type CustomProviderFormErrors,
  type CustomProviderProbeState,
} from "../../lib/customProviders";
import { messageFor } from "../../lib/settingsResource";
import type {
  CreateCustomProviderBody,
  CustomProviderProbeBody,
  CustomProviderProbeResponse,
  CustomProviderSummary,
  UpdateCustomProviderBody,
} from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { CheckIcon, TrashIcon } from "../icons";
import { SelectField } from "../SelectField";
import { ModelIdPicker } from "./ModelIdPicker";

export type CustomProviderFormProps = {
  /** null = 追加。定義があれば編集（provider id は読み取り専用） */
  provider: CustomProviderSummary | null;
  runtimeAvailable: boolean;
  /** この provider の変更が進行中 */
  saving: boolean;
  /** いずれかの provider の変更が進行中 */
  busy: boolean;
  onCreate: (body: CreateCustomProviderBody) => Promise<boolean>;
  onUpdate: (provider: string, body: UpdateCustomProviderBody) => Promise<boolean>;
  onDelete: (provider: string) => Promise<boolean>;
  /** `/models` の probe。設定は変えず、結果だけを返す */
  onProbe: (input: CustomProviderProbeBody) => Promise<CustomProviderProbeResponse>;
  /** 反映待ちの定義を DB から SDK へ写し直す */
  onResync: (provider: string) => Promise<boolean>;
  /** 保存できたら、その provider を選択状態にする */
  onSaved: (provider: string) => void;
  /** 削除できたら選択を解除する */
  onDeleted: () => void;
  /** 追加をやめる（追加モードを閉じる） */
  onCancelAdd: () => void;
};

/**
 * カスタムプロバイダーの追加・編集フォーム。1 provider = 1 model なので、モデル行の追加・削除は持たない。
 * キーは応答に載らないため、編集時は空欄を「既存を維持」として扱う。
 */
export function CustomProviderForm({
  provider,
  runtimeAvailable,
  saving,
  busy,
  onCreate,
  onUpdate,
  onDelete,
  onProbe,
  onResync,
  onSaved,
  onDeleted,
  onCancelAdd,
}: CustomProviderFormProps) {
  const editing = provider !== null;
  const confirm = useConfirm();
  const modelIdInputId = useId();
  const contextWindowRef = useRef<HTMLSpanElement | null>(null);
  const [draft, setDraft] = useState<CustomProviderFormDraft>(() =>
    provider ? customProviderDraftOf(provider) : emptyCustomProviderDraft(),
  );
  const [errors, setErrors] = useState<CustomProviderFormErrors>({});
  const [revision, setRevision] = useState(0);
  // 遅れて届いた応答を、レンダー前でも現在の入力と比べられるように ref でも持つ
  const revisionRef = useRef(0);
  const [probe, setProbe] = useState<CustomProviderProbeState | null>(null);
  const [probing, setProbing] = useState(false);
  const update = (patch: Partial<CustomProviderFormDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // 接続先かキーが変わったら、その前に取った一覧は今の入力の結果ではない
    if ("baseUrl" in patch || "apiKey" in patch) {
      revisionRef.current += 1;
      setRevision(revisionRef.current);
    }
  };

  const currentProbe = currentCustomProviderProbe(probe, revision);
  const probeResult = currentProbe?.result ?? null;
  const probeError = currentProbe?.error ?? null;
  const modelIds =
    probeResult !== null && probeResult.failure === null ? probeResult.models.map((model) => model.id) : [];
  const probeView = probeResult === null ? null : customProviderProbeDisplay(probeResult);
  const missingFromList =
    probeResult !== null && probeResult.failure === null && modelIdMissingFromList(draft.modelId, modelIds);

  /**
   * 一覧を取りに行く。新しく取れた成功結果は使い回し、失敗は空配列で返す (文言は結果行が持つ)。
   * 遅れて届いた結果は revision で捨て、編集後の入力の結果として見せない。
   */
  const probeModels = async (): Promise<readonly string[]> => {
    const fresh = currentCustomProviderProbe(probe, revisionRef.current);
    if (fresh !== null && fresh.result !== null && fresh.result.failure === null) {
      return fresh.result.models.map((model) => model.id);
    }
    const startedAt = revisionRef.current;
    setProbing(true);
    try {
      const result = await onProbe(customProviderProbeBody(draft, editing));
      const outcome = customProviderProbeOutcome({
        startedAt,
        currentRevision: revisionRef.current,
        result,
        error: null,
      });
      setProbe(outcome.state);
      return outcome.ids;
    } catch (error) {
      const outcome = customProviderProbeOutcome({
        startedAt,
        currentRevision: revisionRef.current,
        result: null,
        error: messageFor(error),
      });
      setProbe(outcome.state);
      return outcome.ids;
    } finally {
      setProbing(false);
    }
  };

  // 選択で popover が閉じ、native がトリガーへ焦点を戻す。次の入力へ進めるよう contextWindow へ移す
  const pickModelId = (id: string) => {
    update({ modelId: id });
    window.setTimeout(() => contextWindowRef.current?.querySelector("select")?.focus(), 0);
  };

  const submit = async () => {
    const next = validateCustomProviderDraft(draft, { editing });
    setErrors(next);
    if (customProviderFormHasError(next)) return;
    if (editing) {
      if (!(await onUpdate(provider.id, customProviderUpdateBody(draft)))) return;
      // 送ったキーを入力欄に残さない (次の保存で意図せず再送しない)
      setDraft((current) => ({ ...current, apiKey: "" }));
      onSaved(provider.id);
      return;
    }
    if (await onCreate(customProviderCreateBody(draft))) onSaved(draft.id.trim());
  };

  const remove = async () => {
    if (!editing) return;
    if (!(await confirm(deleteCustomProviderConfirm(provider.name)))) return;
    if (await onDelete(provider.id)) onDeleted();
  };

  const disabled = !runtimeAvailable || saving || busy;
  // 反映待ちは編集・削除を残し (id 衝突や master key 未設定から削除で抜けられる)、
  // 削除待ちの tombstone は再同期だけを出す
  const degradedNotice = provider === null ? null : customProviderDegradedNotice(provider);
  const editable = provider === null || customProviderEditable(provider);
  const resync = async () => {
    if (provider === null) return;
    await onResync(provider.id);
  };
  const probeEnabled = customProviderProbeEnabled({
    draft,
    editing,
    hasStoredKey: provider?.hasKey ?? false,
    runtimeAvailable,
    busy,
    probing,
  });

  return (
    <section className="grid gap-4">
      <div className="grid gap-2 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="text-md font-semibold text-ink-strong">
            {editing ? provider.name : "カスタムプロバイダーを追加"}
          </h2>
          <code className="text-2xs text-ink-ghost">{editing ? provider.id : "新しい provider"}</code>
        </div>
        <p className="text-2xs leading-relaxed text-ink-muted">
          OpenAI 互換（<code>openai-completions</code>）のエンドポイントを 1 件だけ登録します。1 provider = 1 model
          です。
        </p>
      </div>

      {runtimeAvailable ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          ランタイムが利用できないため、カスタムプロバイダーを変更できません。サーバーの起動ログを確認してください。
        </p>
      )}

      {degradedNotice ? (
        <div className="grid gap-2 rounded-lg border border-warn/40 bg-raised px-2.5 py-2">
          <p role="alert" className="text-2xs leading-relaxed text-warn">
            {degradedNotice}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-quiet"
              disabled={busy || !runtimeAvailable}
              onClick={() => void resync()}
            >
              再同期
            </button>
          </div>
        </div>
      ) : null}

      {editable ? null : (
        <p className="text-2xs leading-relaxed text-ink-muted">
          削除の後始末が終わるまで、この定義は編集も削除もできません。[再同期] を実行してください。
        </p>
      )}

      {editable ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid content-start gap-1 text-2xs text-ink-soft">
              provider id
              <input
                className="field min-w-0 text-xs"
                value={draft.id}
                readOnly={editing}
                placeholder="local-llm"
                aria-label="provider id"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.id ? true : undefined}
                onChange={(event) => update({ id: event.currentTarget.value })}
              />
              <span className="text-ink-ghost">
                {editing ? "provider id は作成後に変更できません。" : "英小文字で始まり、英小文字・数字・ハイフン。"}
              </span>
              {errors.id ? <span className="text-warn">{errors.id}</span> : null}
            </label>
            <label className="grid content-start gap-1 text-2xs text-ink-soft">
              名前（任意）
              <input
                className="field min-w-0 text-xs"
                value={draft.name}
                placeholder="空欄なら provider id"
                aria-label="名前"
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                onChange={(event) => update({ name: event.currentTarget.value })}
              />
              <span className="text-ink-ghost">表示名だけです。送信するモデル名はモデル ID のままです。</span>
              {errors.name ? <span className="text-warn">{errors.name}</span> : null}
            </label>
          </div>

          <label className="grid content-start gap-1 text-2xs text-ink-soft">
            baseUrl
            <input
              className="field min-w-0 text-xs"
              value={draft.baseUrl}
              placeholder="http://192.0.2.10:11434/v1"
              aria-label="baseUrl"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.baseUrl ? true : undefined}
              onChange={(event) => update({ baseUrl: event.currentTarget.value })}
            />
            <span className="text-ink-ghost">`/v1` まで含めます。userinfo・query・fragment は指定できません。</span>
            {errors.baseUrl ? <span className="text-warn">{errors.baseUrl}</span> : null}
          </label>

          <label className="grid content-start gap-1 text-2xs text-ink-soft">
            APIキー
            <input
              className="field min-w-0 text-xs"
              type="password"
              value={draft.apiKey}
              placeholder={editing && provider.hasKey ? "空欄なら既存のAPIキーを維持" : "APIキー（8 文字以上）"}
              aria-label="APIキー"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.apiKey ? true : undefined}
              onChange={(event) => update({ apiKey: event.currentTarget.value })}
            />
            <span className="text-ink-ghost">
              認証のないローカルサーバーにはダミーを入れます（送信時に Authorization: Bearer として付きます）。
            </span>
            {errors.apiKey ? <span className="text-warn">{errors.apiKey}</span> : null}
          </label>

          <div className="grid content-start gap-1 text-2xs text-ink-soft">
            <label htmlFor={modelIdInputId}>モデル ID</label>
            <div className="flex min-w-0 items-start gap-1.5">
              <input
                id={modelIdInputId}
                className="field min-w-0 flex-1 text-xs"
                value={draft.modelId}
                placeholder="qwen2.5-coder:7b"
                aria-label="モデル ID"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.modelId ? true : undefined}
                onChange={(event) => update({ modelId: event.currentTarget.value })}
              />
              <ModelIdPicker
                value={draft.modelId}
                loading={probing}
                disabled={!probeEnabled}
                onRequest={probeModels}
                onPick={pickModelId}
              />
            </div>
            {probing ? (
              <span role="status" className="text-2xs text-ink-muted">
                {CUSTOM_PROVIDER_PROBE_PENDING_NOTE}
              </span>
            ) : null}
            {!probing && probeError !== null ? (
              <span role="alert" className="text-2xs text-warn">
                {probeError}
              </span>
            ) : null}
            {!probing && probeError === null && probeView !== null ? (
              <span role={probeView.kind === "success" ? "status" : "alert"} className="grid gap-0.5">
                <span className={probeView.kind === "success" ? "text-ink-muted" : "text-warn"}>
                  {probeView.message}
                </span>
                {probeView.detail ? <span className="text-3xs text-ink-faint">{probeView.detail}</span> : null}
              </span>
            ) : null}
            {!probing && missingFromList ? (
              <span role="status" className="text-2xs text-warn">
                {CUSTOM_PROVIDER_PROBE_MISSING_NOTE}
              </span>
            ) : null}
            {errors.modelId ? <span className="text-warn">{errors.modelId}</span> : null}
          </div>

          <label className="grid content-start gap-1 text-2xs text-ink-soft">
            contextWindow
            <span ref={contextWindowRef} className="contents">
              <SelectField
                wrapperClassName="w-full"
                value={draft.contextWindow}
                aria-label="contextWindow"
                autoComplete="off"
                aria-invalid={errors.contextWindow ? true : undefined}
                onChange={(event) => update({ contextWindow: event.currentTarget.value })}
              >
                <option value="">選択してください</option>
                {contextWindowOptions(draft.contextWindow).map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            </span>
            <span className="text-ink-ghost">{CUSTOM_PROVIDER_CONTEXT_WINDOW_NOTE}</span>
            {errors.contextWindow ? <span className="text-warn">{errors.contextWindow}</span> : null}
          </label>

          <details className="rounded-lg border border-line bg-soft px-2.5 py-2">
            <summary className="cursor-pointer text-2xs text-ink-soft">詳細（maxTokens）</summary>
            <div className="grid content-start gap-1 pt-2 text-2xs text-ink-soft">
              <label className="grid content-start gap-1">
                maxTokens（任意）
                <input
                  className="field min-w-0 text-xs"
                  inputMode="numeric"
                  value={draft.maxTokens}
                  placeholder={String(CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS)}
                  aria-label="maxTokens"
                  autoComplete="off"
                  aria-invalid={errors.maxTokens ? true : undefined}
                  onChange={(event) => update({ maxTokens: event.currentTarget.value })}
                />
              </label>
              <span className="text-ink-ghost">空欄なら {CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS} を使います。</span>
              {errors.maxTokens ? <span className="text-warn">{errors.maxTokens}</span> : null}
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={disabled}>
              <CheckIcon />
              {editing ? "保存" : "登録"}
            </button>
            {editing ? (
              <button type="button" className="btn-quiet" disabled={disabled} onClick={() => void remove()}>
                <TrashIcon />
                削除
              </button>
            ) : (
              <button type="button" className="btn-quiet" onClick={onCancelAdd}>
                キャンセル
              </button>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}
