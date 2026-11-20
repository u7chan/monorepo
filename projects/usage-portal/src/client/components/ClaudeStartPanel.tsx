import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ClaudeStartState } from "../api";
import { claudeStartReason, describeClaudeStartRun } from "../lib/claude-start";
import { formatClock, formatDateTime } from "../lib/format";
import {
  CLAUDE_START_EFFORTS,
  CLAUDE_START_MAX_COUNT,
  CLAUDE_START_MAX_FAILURES,
  CLAUDE_START_MODELS,
  CLAUDE_START_WINDOW_MINUTES,
  formatMinuteOfDay,
  recommendedStartOption,
  startCycle,
  startCycleOptions,
  type ClaudeStartEffort,
  type ClaudeStartModel,
  type ClaudeStartSettings,
} from "../../shared/claude-start";

export type ClaudeStartTab = "plan" | "log";

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
/** 曜日の並びは月曜始まり。カレンダーより平日・週末の区切りが分かりやすい。 */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_MINUTES = 24 * 60;
const COUNTS = Array.from({ length: CLAUDE_START_MAX_COUNT }, (_, index) => index + 1);

type Form = {
  anchor: string;
  count: number;
  /** null は「おすすめ」に従う。時刻か回数を変えたら null に戻す。 */
  option: number | null;
  days: number[];
  model: ClaudeStartModel | "";
  effort: ClaudeStartEffort | "";
};

/** モデルと思考レベルは既定値を置かない（ADR 0017 と同じ）。時刻・回数・曜日は入力の出発点として埋める。 */
function initialForm(settings: ClaudeStartSettings | null): Form {
  if (settings === null) {
    return {
      anchor: "22:00",
      count: CLAUDE_START_MAX_COUNT,
      option: null,
      days: [0, 1, 2, 3, 4, 5, 6],
      model: "",
      effort: "",
    };
  }

  return {
    anchor: formatMinuteOfDay(settings.anchorMinute).padStart(5, "0"),
    count: settings.count,
    option: settings.option,
    days: settings.days,
    model: settings.model,
    effort: settings.effort,
  };
}

function anchorMinute(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);

  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function ClaudeStartPanel(props: {
  state: ClaudeStartState;
  initialTab: ClaudeStartTab;
  onSave: (settings: ClaudeStartSettings) => Promise<string | null>;
  onToggle: (enabled: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const { state } = props;
  const [tab, setTab] = useState<ClaudeStartTab>(props.initialTab);
  const [form, setForm] = useState<Form>(() => initialForm(state.settings));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ failed: boolean; text: string } | null>(null);
  const minute = anchorMinute(form.anchor);
  const option = minute === null ? 1 : (form.option ?? recommendedStartOption(minute, form.count));
  const settings: ClaudeStartSettings | null =
    minute === null || form.model === "" || form.effort === "" || form.days.length === 0
      ? null
      : {
          anchorMinute: minute,
          count: form.count,
          option,
          days: [...form.days].sort((a, b) => a - b),
          timeZone: state.settings?.timeZone ?? browserTimeZone(),
          model: form.model,
          effort: form.effort,
        };
  const dirty =
    settings === null ||
    state.settings === null ||
    JSON.stringify({ ...settings, timeZone: null }) !== JSON.stringify({ ...state.settings, timeZone: null });
  const alerting = state.failures > 0 || (!state.enabled && state.stoppedCode !== null);

  const run = async (task: () => Promise<string | null>, success: string): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const error = await task();

      setMessage(error === null ? { failed: false, text: success } : { failed: true, text: saveError(error) });
    } catch {
      setMessage({ failed: true, text: "通信に失敗しました。もう一度試してください。" });
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<Form>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setMessage(null);
  };

  return (
    <div class="up-start">
      <Segmented
        label="表示"
        role="tablist"
        items={[
          { value: "plan", label: "予約" },
          { value: "log", label: "履歴", marked: alerting },
        ]}
        value={tab}
        onChange={(value) => setTab(value as ClaudeStartTab)}
      />

      {tab === "plan" ? (
        <div class="up-start-panel" role="tabpanel" key="plan">
          <div class="up-switch-row">
            <div class="up-switch-text">
              <span class="up-switch-title" id="up-start-switch">
                自動で開始する
              </span>
              <span class="up-caption">{switchCaption(state)}</span>
            </div>
            <button
              type="button"
              class="up-switch"
              role="switch"
              aria-checked={state.enabled}
              aria-labelledby="up-start-switch"
              disabled={busy || state.settings === null}
              onClick={() =>
                void run(
                  () => props.onToggle(!state.enabled),
                  state.enabled ? "自動の開始をオフにしました。" : "自動の開始をオンにしました。",
                )
              }
            />
          </div>

          <StartAlert state={state} onShowLog={() => setTab("log")} />

          <div class="up-start-row">
            <label class="up-field">
              <span class="up-label">必ずリセットさせる時刻</span>
              <input
                class="up-input"
                type="time"
                step={60}
                value={form.anchor}
                onInput={(event) => update({ anchor: (event.currentTarget as HTMLInputElement).value, option: null })}
              />
            </label>
            <div class="up-field">
              <span class="up-label" id="up-start-count">
                1 日の回数
              </span>
              <Segmented
                label="1 日の回数"
                labelledBy="up-start-count"
                items={COUNTS.map((count) => ({ value: String(count), label: String(count) }))}
                value={String(form.count)}
                onChange={(value) => update({ count: Number(value), option: null })}
              />
            </div>
          </div>

          {minute === null ? null : (
            <>
              <label class="up-field">
                <span class="up-label">空ける時間（この間に使うと、その日の時刻が崩れます）</span>
                <select
                  class="up-input up-select"
                  value={String(option)}
                  onChange={(event) => update({ option: Number((event.currentTarget as HTMLSelectElement).value) })}
                >
                  {startCycleOptions(minute, form.count).map((cycle) => (
                    <option value={String(cycle.option)} key={cycle.option}>
                      {`${formatMinuteOfDay(cycle.gapFrom)}〜${formatMinuteOfDay(cycle.gapTo)}（${(cycle.gapTo - cycle.gapFrom) / 60} 時間）`}
                      {cycle.option === recommendedStartOption(minute, form.count) ? "　おすすめ" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Timeline anchor={minute} count={form.count} option={option} />
              <p class="up-caption up-start-lines">
                {state.enabled && !dirty && state.nextStartAt !== null
                  ? `次の開始 ${formatDateTime(state.nextStartAt)}`
                  : dirty && state.settings !== null
                    ? "保存すると、この時刻で予約します。"
                    : null}
              </p>
            </>
          )}

          <div class="up-field">
            <span class="up-label" id="up-start-days">
              曜日（空けた時間のあと、最初の開始の日）
            </span>
            <div class="up-days" role="group" aria-labelledby="up-start-days">
              {DAY_ORDER.map((day) => (
                <button
                  type="button"
                  class="up-day"
                  key={day}
                  aria-pressed={form.days.includes(day)}
                  onClick={() =>
                    update({
                      days: form.days.includes(day) ? form.days.filter((value) => value !== day) : [...form.days, day],
                    })
                  }
                >
                  {DAY_LABELS[day]}
                </button>
              ))}
            </div>
          </div>

          <Disclosure
            title="送信の設定"
            summary={form.model === "" || form.effort === "" ? "未設定" : `${form.model} / ${form.effort}`}
            initiallyOpen={state.settings === null}
          >
            <div class="up-start-row">
              <label class="up-field">
                <span class="up-label">モデル</span>
                <select
                  class="up-input up-select"
                  value={form.model}
                  onChange={(event) =>
                    update({ model: (event.currentTarget as HTMLSelectElement).value as ClaudeStartModel })
                  }
                >
                  <option value="">選択してください</option>
                  {CLAUDE_START_MODELS.map((model) => (
                    <option value={model} key={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <label class="up-field">
                <span class="up-label">思考レベル</span>
                <select
                  class="up-input up-select"
                  value={form.effort}
                  onChange={(event) =>
                    update({ effort: (event.currentTarget as HTMLSelectElement).value as ClaudeStartEffort })
                  }
                >
                  <option value="">選択してください</option>
                  {CLAUDE_START_EFFORTS.map((effort) => (
                    <option value={effort} key={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p class="up-caption">固定の 1 文を送り、1 文字だけ返させます。応答は保存しません。</p>
          </Disclosure>

          <div class="up-form-actions">
            <button
              class="up-button"
              type="button"
              disabled={busy || settings === null || !dirty}
              onClick={() => {
                if (settings !== null) {
                  void run(() => props.onSave({ ...settings, timeZone: browserTimeZone() }), "保存しました。");
                }
              }}
            >
              {busy ? "保存中…" : "保存する"}
            </button>
            <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={props.onClose}>
              閉じる
            </button>
          </div>
        </div>
      ) : (
        <div class="up-start-panel" role="tabpanel" key="log">
          <History state={state} />
          <div class="up-form-actions">
            <button class="up-button up-button-secondary" type="button" onClick={props.onClose}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {message === null ? null : (
        <p class={message.failed ? "up-error" : "up-caption"} role={message.failed ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function switchCaption(state: ClaudeStartState): string {
  if (state.settings === null) {
    return "モデルと思考レベルを選んで保存すると、オンにできます";
  }

  if (!state.enabled) {
    return state.stoppedCode === null
      ? "予約は残したまま、送信を止めています"
      : "オンにすると、連続失敗の数を 0 に戻して再開します";
  }

  return "予約した時刻に Claude の 5 時間を開始します";
}

function saveError(error: string): string {
  switch (error) {
    case "invalid_request":
      return "入力を確かめてください。";
    case "not_configured":
      return "先に予約を保存してください。";
    default:
      return "保存できませんでした。もう一度試してください。";
  }
}

function StartAlert(props: { state: ClaudeStartState; onShowLog: () => void }) {
  const { state } = props;
  const lastFailure = state.runs.find((run) => run.kind === "auto" && run.outcome === "failed") ?? null;
  const reason = claudeStartReason(state.stoppedCode ?? lastFailure?.code ?? null);

  if (!state.enabled && state.stoppedCode !== null) {
    return (
      <div class="up-start-alert up-start-alert-danger" role="alert">
        <strong>自動の開始を止めました</strong>
        <span>
          {CLAUDE_START_MAX_FAILURES} 回続けて失敗しました（{reason}
          ）。原因を直してから、上のスイッチをオンにしてください。{" "}
          <button type="button" class="up-link-button" onClick={props.onShowLog}>
            履歴を見る
          </button>
        </span>
      </div>
    );
  }

  if (state.enabled && state.failures > 0) {
    return (
      <div class="up-start-alert up-start-alert-attention" role="status">
        <strong>
          直前の開始に失敗しました（{reason}） {state.failures}/{CLAUDE_START_MAX_FAILURES}
        </strong>
        <span>
          あと {CLAUDE_START_MAX_FAILURES - state.failures} 回続けて失敗すると、自動の開始を止めます。{" "}
          <button type="button" class="up-link-button" onClick={props.onShowLog}>
            履歴を見る
          </button>
        </span>
      </div>
    );
  }

  return null;
}

/** 24 時間の帯に、窓・空き・必ずリセットさせる時刻を重ねる。 */
function Timeline(props: { anchor: number; count: number; option: number }) {
  const cycle = startCycle(props.anchor, props.count, props.option);
  const segments = [
    ...cycle.starts.map((start, index) => ({
      from: start,
      length: CLAUDE_START_WINDOW_MINUTES,
      kind: "window",
      index,
    })),
    { from: cycle.gapFrom, length: cycle.gapTo - cycle.gapFrom, kind: "gap", index: props.count },
  ].flatMap((segment) => splitAtMidnight(segment.from, segment.length).map((part) => ({ ...segment, ...part })));
  const resets = cycle.starts.map((start) => start + CLAUDE_START_WINDOW_MINUTES);

  return (
    <div class="up-start-preview">
      <div class="up-timeline" aria-hidden="true">
        {segments.map((segment) => (
          <span
            key={`${segment.kind}-${segment.index}-${segment.from}`}
            class={`up-timeline-seg up-timeline-${segment.kind}${segment.index % 2 === 1 ? " up-timeline-alt" : ""}`}
            style={{
              left: `${(segment.from / DAY_MINUTES) * 100}%`,
              width: `${(segment.length / DAY_MINUTES) * 100}%`,
            }}
          >
            {segment.length >= 120 ? (segment.kind === "gap" ? "空き" : `窓${segment.index + 1}`) : ""}
          </span>
        ))}
        <span class="up-timeline-anchor" style={{ left: `${(props.anchor / DAY_MINUTES) * 100}%` }} />
      </div>
      <div class="up-timeline-axis" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((hour) => (
          <span key={hour}>{hour}</span>
        ))}
      </div>
      <p class="up-caption up-start-lines">
        開始 {cycle.starts.map((start) => formatMinuteOfDay(start)).join(" / ")}
        <br />
        リセット{" "}
        {resets.map((reset, index) => (
          <span key={reset}>
            {index > 0 ? " / " : ""}
            {reset % DAY_MINUTES === props.anchor ? (
              <strong>{formatMinuteOfDay(reset)}（必ず）</strong>
            ) : (
              formatMinuteOfDay(reset)
            )}
          </span>
        ))}
      </p>
    </div>
  );
}

function splitAtMidnight(from: number, length: number): { from: number; length: number }[] {
  const start = ((from % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

  return start + length <= DAY_MINUTES
    ? [{ from: start, length }]
    : [
        { from: start, length: DAY_MINUTES - start },
        { from: 0, length: start + length - DAY_MINUTES },
      ];
}

function History(props: { state: ClaudeStartState }) {
  if (props.state.runs.length === 0) {
    return <p class="up-caption">まだ実行していません。</p>;
  }

  return (
    <>
      <table class="up-start-history">
        <thead>
          <tr>
            <th scope="col">予定</th>
            <th scope="col">結果</th>
            <th scope="col">リセット</th>
          </tr>
        </thead>
        <tbody>
          {props.state.runs.map((run, index) => {
            const described = describeClaudeStartRun(run);

            return (
              <tr key={`${run.ranAt}-${index}`}>
                <td class="up-nowrap-cell">{formatDateTime(run.slotAt ?? run.ranAt)}</td>
                <td>
                  <span class={`up-start-result up-start-result-${described.tone}`}>{described.label}</span>
                  <span class="up-start-detail">{described.detail}</span>
                </td>
                <td class="up-nowrap-cell">
                  {run.outcome === "ok" && run.resetsAt !== null ? formatClock(run.resetsAt) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="up-caption">
        直近 20 件。見送り（窓が動いていた・上限に達していた・時刻を過ぎた）は、{CLAUDE_START_MAX_FAILURES}{" "}
        回の失敗に数えません。
      </p>
    </>
  );
}

/** 選んだ項目の下に印が滑って移る。タブと回数で使う。 */
function Segmented(props: {
  label: string;
  labelledBy?: string;
  role?: "tablist";
  items: { value: string; label: string; marked?: boolean }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const index = Math.max(
    0,
    props.items.findIndex((item) => item.value === props.value),
  );
  const tabs = props.role === "tablist";

  return (
    <div
      class={tabs ? "up-slider up-slider-tabs" : "up-slider"}
      role={props.role ?? "group"}
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      style={`--up-slider-count: ${props.items.length}; --up-slider-index: ${index}`}
    >
      <span class="up-slider-thumb" aria-hidden="true" />
      {props.items.map((item) => {
        const selected = item.value === props.value;

        return (
          <button
            type="button"
            key={item.value}
            class="up-slider-item"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-pressed={tabs ? undefined : selected}
            onClick={() => props.onChange(item.value)}
          >
            {item.label}
            {item.marked ? <span class="up-slider-mark" aria-label="要確認" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 開閉を高さのアニメーションで見せる。`<details>` は閉じるときに中身が先に消え、動かせない。 */
function Disclosure(props: { title: string; summary: string; initiallyOpen: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(props.initiallyOpen);

  return (
    <div class="up-disclosure" data-open={open}>
      <button type="button" class="up-disclosure-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{props.title}</span>
        <span class="up-caption">{props.summary}</span>
        <span class="up-disclosure-chevron" aria-hidden="true" />
      </button>
      <div class="up-disclosure-body" inert={!open}>
        <div class="up-disclosure-inner">{props.children}</div>
      </div>
    </div>
  );
}
