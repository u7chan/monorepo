import { useState } from "preact/hooks";
import {
  DEFAULT_FETCH_INTERVAL_MINUTES,
  FETCH_INTERVAL_OPTIONS_MINUTES,
  FETCH_INTERVAL_PROVIDERS,
  type FetchIntervalProvider,
} from "../../shared/fetch-interval";
import type { FetchIntervals } from "../api";

const PROVIDER_LABELS: Record<FetchIntervalProvider, string> = {
  codex: "Codex",
  "opencode-go": "OpenCode Go",
};

const FALLBACK: FetchIntervals = {
  codex: DEFAULT_FETCH_INTERVAL_MINUTES * 60_000,
  "opencode-go": DEFAULT_FETCH_INTERVAL_MINUTES * 60_000,
};

/** 取得間隔はサーバー全体で 1 つ。端末ごとではないことを文言で示す。 */
export function FetchIntervalForm(props: {
  intervals: FetchIntervals | null;
  /** 変更した provider だけを保存する。成功なら null、失敗なら画面に出す文言。 */
  onSave: (next: FetchIntervals) => Promise<string | null>;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState<Record<FetchIntervalProvider, number>>(() =>
    toMinutes(props.intervals ?? FALLBACK),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const error = await props.onSave(toMilliseconds(minutes));

      if (error === null) {
        props.onClose();
      } else {
        setMessage(error);
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
        void submit();
      }}
    >
      <p class="up-caption">
        上流の利用枠を取りに行く間隔です。この設定はサーバー全体に効き、登録済みの端末すべてに反映されます。 OpenCode Go
        はアカウントごとに取得するため、回数は「間隔 × アカウント数」になります。
      </p>

      {FETCH_INTERVAL_PROVIDERS.map((provider) => (
        <label class="up-field" key={provider}>
          <span class="up-label">{PROVIDER_LABELS[provider]}</span>
          <select
            class="up-input"
            value={String(minutes[provider])}
            disabled={busy}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);

              setMinutes((current) => ({ ...current, [provider]: value }));
            }}
          >
            {FETCH_INTERVAL_OPTIONS_MINUTES.map((option) => (
              <option value={String(option)} key={option}>
                {option} 分
              </option>
            ))}
          </select>
        </label>
      ))}

      {message ? (
        <p class="up-error" role="alert">
          {message}
        </p>
      ) : null}

      <div class="up-form-actions">
        <button type="button" class="up-button up-button-secondary" onClick={props.onClose} disabled={busy}>
          キャンセル
        </button>
        <button type="submit" class="up-button" disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}

function toMinutes(intervals: FetchIntervals): Record<FetchIntervalProvider, number> {
  return {
    codex: Math.round(intervals.codex / 60_000),
    "opencode-go": Math.round(intervals["opencode-go"] / 60_000),
  };
}

function toMilliseconds(minutes: Record<FetchIntervalProvider, number>): FetchIntervals {
  return {
    codex: minutes.codex * 60_000,
    "opencode-go": minutes["opencode-go"] * 60_000,
  };
}
