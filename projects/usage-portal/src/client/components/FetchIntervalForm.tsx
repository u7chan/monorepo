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

/** 取得間隔はサーバー全体で 1 つ。端末ごとではないことを文言で示す。 */
export function FetchIntervalForm(props: {
  /** 読み込み済みの現在値。未取得のまま開かせない（保存で既存値を上書きしないため）。 */
  intervals: FetchIntervals;
  /** 変更した provider だけを保存する。成功なら null、失敗なら画面に出す文言。 */
  onSave: (next: FetchIntervals) => Promise<string | null>;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState<Record<FetchIntervalProvider, number>>(() =>
    selectableMinutes(props.intervals),
  );
  // env の POLL_INTERVAL_MS が一覧に無い値（1 分など）だと、そのままでは選択欄に表示できない。
  const outsideOptions = usesOutsideOptions(props.intervals);
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

      {outsideOptions ? (
        <p class="up-caption">
          現在は一覧にない間隔（環境変数の設定）で動いています。保存すると、一覧から選んだ値に切り替わります。
        </p>
      ) : null}

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

function selectableMinutes(intervals: FetchIntervals): Record<FetchIntervalProvider, number> {
  return {
    codex: selectableMinutesOf(intervals.codex),
    "opencode-go": selectableMinutesOf(intervals["opencode-go"]),
  };
}

/** 一覧にない値は既定へ寄せる。空の選択欄や、そのまま保存して 400 になる状態を作らない。 */
function selectableMinutesOf(milliseconds: number): number {
  const minutes = milliseconds / 60_000;

  return (FETCH_INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(minutes)
    ? minutes
    : DEFAULT_FETCH_INTERVAL_MINUTES;
}

function usesOutsideOptions(intervals: FetchIntervals): boolean {
  return (
    !(FETCH_INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(intervals.codex / 60_000) ||
    !(FETCH_INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(intervals["opencode-go"] / 60_000)
  );
}

function toMilliseconds(minutes: Record<FetchIntervalProvider, number>): FetchIntervals {
  return {
    codex: minutes.codex * 60_000,
    "opencode-go": minutes["opencode-go"] * 60_000,
  };
}
