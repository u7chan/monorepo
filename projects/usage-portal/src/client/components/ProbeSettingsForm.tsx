import { useState } from "preact/hooks";
import type { CodexProbeConfig, ProbeModel } from "../api";
import { probeErrorMessage } from "../lib/probe";

/** 選択肢の既定は置かない。両方を選ぶまで保存できない。 */
export function ProbeSettingsForm(props: {
  models: readonly ProbeModel[];
  config: CodexProbeConfig | null;
  onSave: (config: CodexProbeConfig) => Promise<string | null>;
  onClear: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [model, setModel] = useState(props.config?.model ?? "");
  const [thinking, setThinking] = useState(props.config?.thinking ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = props.models.find((candidate) => candidate.id === model) ?? null;
  const levels = selected?.thinkingLevels ?? [];
  const level = levels.includes(thinking) ? thinking : "";
  const complete = selected !== null && level !== "";

  const run = async (task: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const error = await task();

      if (error === null) {
        props.onClose();
      } else {
        setMessage(probeErrorMessage(error));
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="up-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (complete) {
          void run(() => props.onSave({ model, thinking: level }));
        }
      }}
    >
      <p class="up-caption">
        5 時間の利用枠を開始するときに送るモデルと思考レベルです。応答は保存せず、送信の成否だけを使います。
      </p>

      <label class="up-field">
        <span class="up-label">モデル</span>
        <select
          class="up-input"
          value={model}
          onChange={(event) => {
            setModel((event.currentTarget as HTMLSelectElement).value);
            setThinking("");
          }}
        >
          <option value="">選択してください</option>
          {props.models.map((candidate) => (
            <option value={candidate.id} key={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>

      <label class="up-field">
        <span class="up-label">思考レベル</span>
        <select
          class="up-input"
          value={level}
          disabled={selected === null}
          onChange={(event) => setThinking((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">選択してください</option>
          {levels.map((candidate) => (
            <option value={candidate} key={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </label>

      {selected ? (
        <p class="up-caption">
          参考コスト（1M token あたり）: 入力 {selected.cost.input} / 出力 {selected.cost.output}
        </p>
      ) : null}

      <div class="up-form-actions">
        <button class="up-button" type="submit" disabled={busy || !complete}>
          {busy ? "保存中…" : "保存する"}
        </button>
        {props.config ? (
          <button
            class="up-button up-button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void run(() => props.onClear())}
          >
            設定を解除
          </button>
        ) : null}
        <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={props.onClose}>
          キャンセル
        </button>
      </div>

      {props.config ? (
        <p class="up-caption">
          現在の設定: {props.config.model} / {props.config.thinking}
        </p>
      ) : null}

      {message ? (
        <p class="up-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
