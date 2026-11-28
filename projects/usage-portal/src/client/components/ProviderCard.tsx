import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { UsageSource } from "../api";
import { isOnDemandProvider } from "../../shared/on-demand";
import {
  describeAge,
  describeClaudeResetCredits,
  describeResetCredits,
  formatClock,
  formatDateTime,
  formatFetchInterval,
} from "../lib/format";
import { deriveProviderStatus, showsWindows } from "../lib/status";
import { arrangeWindowSlots, findBlockedWindows, pickTrendWindow } from "../lib/windows";
import { AccountIcon } from "./AccountIcon";
import { ProviderIcon } from "./ProviderIcon";
import { ResetCreditsSection } from "./ResetCreditsSection";
import { StatusLabel } from "./StatusLabel";
import { TrendChart } from "./Trend";
import { AbsentMeter, UsageMeter } from "./UsageMeter";

export function ProviderCard(props: {
  source: UsageSource;
  now: number;
  /** 推移の右端。再取得のたびにグラフが横にずれないよう、描画時刻ではなく応答時刻を使う。 */
  generatedAt: number | null;
  /** 推移を省いてカードを短くする。3 件をスクロールせず見たいときの表示。 */
  compact?: boolean;
  /** provider ごとの操作（編集・削除など）。見出しの右に置く。 */
  headerMenu?: ComponentChildren;
  /** provider ごとの詳細。フッターの下に開く。 */
  children?: ComponentChildren;
}) {
  const { source } = props;
  const status = deriveProviderStatus({
    provider: source.provider,
    state: source.state,
    errorCode: source.error?.code ?? null,
    limitReached: source.limitReached,
    usedPercents: source.windows.map((window) => window.usedPercent),
  });
  const showMeters = showsWindows(source.state) && source.windows.length > 0;
  const chartWindows = showMeters ? source.windows : [];
  // 取得に失敗した snapshot に「枠が無い」と書かない。空きスロットは正常な応答のときだけ足す。
  const windowSlots =
    source.state === "ok"
      ? arrangeWindowSlots(source.provider, source.windows)
      : source.windows.map((window) => ({ window }));
  const blocked = findBlockedWindows(chartWindows);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const activeWindow = chartWindows.find((window) => window.id === selectedWindowId) ?? pickTrendWindow(chartWindows);
  const activeTrend = activeWindow ? (source.trends.find((trend) => trend.windowId === activeWindow.id) ?? null) : null;
  const intervalLabel = formatFetchInterval(source.fetchIntervalMs);
  const resetCredits =
    source.provider === "claude"
      ? describeClaudeResetCredits(source.claudeResetCredits, props.now)
      : source.resetCredits
        ? describeResetCredits(source.resetCredits, props.now)
        : null;
  const hint = retryHint(source, intervalLabel);
  const capturedAt = source.capturedAt;
  const ageLabel = capturedAt === null ? null : describeAge(props.now - capturedAt);
  // バーの経過は capturedAt ごとに固定する。再描画のたびに経過を計算し直すと
  // animation-delay が変わり、アニメーションが先頭からやり直しになる。
  // 予定を過ぎて満タンのまま止まる状態を正常系として出す。失敗・停止中はバーを出さない。
  const bar = useMemo(() => {
    if (source.state !== "ok" || source.capturedAt === null || source.nextFetchAt === null) {
      return null;
    }

    // 次回予定は sampler が決めた値。取得にかかった時間も含むので、capturedAt + 間隔 で近似しない。
    const durationMs = source.nextFetchAt - source.capturedAt;

    if (!(durationMs > 0)) {
      return null;
    }

    return {
      capturedAt: source.capturedAt,
      nextFetchAt: source.nextFetchAt,
      durationMs,
      elapsedMs: Math.min(durationMs, Math.max(0, props.now - source.capturedAt)),
    };
    // props.now は依存に入れない。マウント時の経過をそのままバーの開始位置にする。
  }, [source.state, source.capturedAt, source.nextFetchAt]);

  return (
    <article class="up-card up-provider" data-mark={status.mark}>
      <header class="up-provider-head">
        <div class="up-provider-title">
          <ProviderIcon provider={source.provider} mark={status.mark} />
          {source.account ? <AccountIcon id={source.account.id} icon={source.account.icon} /> : null}
          <h2 class="up-provider-name">{source.name}</h2>
          {source.account ? (
            <span class="up-caption up-provider-caption">OpenCode Go</span>
          ) : source.plan ? (
            <span class="up-caption up-provider-caption">{source.plan}</span>
          ) : null}
        </div>
        <div class="up-provider-actions">
          <StatusLabel status={status} />
          {props.headerMenu}
        </div>
      </header>

      {source.state === "loading" ? <p class="up-caption">利用枠を取得しています。</p> : null}

      {showMeters ? (
        <div class="up-meters">
          {windowSlots.map((slot) =>
            "window" in slot ? (
              <UsageMeter
                key={slot.window.id}
                window={slot.window}
                now={props.now}
                blockedBy={blocked.get(slot.window.id)?.byLabel ?? null}
              />
            ) : (
              <AbsentMeter key={`absent:${slot.label}`} label={slot.label} note={slot.absentNote} />
            ),
          )}
        </div>
      ) : null}

      {source.state === "stale" ? (
        <div class="up-empty">
          <p class="up-caption">
            {capturedAt === null
              ? "前回取得した値を表示しています。"
              : `${formatClock(capturedAt)} に取得した値を表示しています。`}
          </p>
          {source.error ? <p class="up-caption">{source.error.message}</p> : null}
          <p class="up-caption">{hint}</p>
        </div>
      ) : null}

      {source.state === "error" ? (
        <div class="up-empty">
          <p class="up-caption">{source.error ? source.error.message : "利用枠を取得できませんでした。"}</p>
          <p class="up-caption">{hint}</p>
        </div>
      ) : null}

      {resetCredits ? <ResetCreditsSection view={resetCredits} /> : null}

      {activeWindow && !props.compact ? (
        <TrendChart
          windows={chartWindows}
          activeWindowId={activeWindow.id}
          trend={activeTrend}
          generatedAt={props.generatedAt}
          emptyMessage={
            isOnDemandProvider(source.provider)
              ? "履歴を収集中です（取得するたびに記録）。"
              : `履歴を収集中です（${intervalLabel}ごとに記録）。`
          }
          onSelect={setSelectedWindowId}
        />
      ) : null}

      {source.notes.length > 0 ? (
        <ul class="up-notes">
          {source.notes.map((note) => (
            <li class="up-caption" key={note}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <footer class="up-provider-foot">
        <p class="up-caption" title={capturedAt === null ? undefined : `${formatDateTime(capturedAt)} に取得`}>
          {capturedAt === null
            ? "まだ取得していません"
            : [
                // 簡易表示では間隔まで出さず、値の古さだけを残す。
                props.compact
                  ? null
                  : isOnDemandProvider(source.provider)
                    ? "画面を開いたときと手動更新で取得"
                    : `${intervalLabel}間隔`,
                ageLabel,
              ]
                .filter((part) => part !== null)
                .join("・")}
        </p>
        {bar === null ? null : (
          <div class="up-fetch" aria-hidden="true">
            <span
              key={`${bar.capturedAt}:${bar.nextFetchAt}`}
              class="up-fetch-fill"
              style={{ animationDuration: `${bar.durationMs}ms`, animationDelay: `-${bar.elapsedMs}ms` }}
            />
          </div>
        )}
      </footer>

      {props.children}
    </article>
  );
}

/** 自動再取得が無い provider だけ、取り直す入口をメニューだと伝える。 */
function retryHint(source: UsageSource, intervalLabel: string): string {
  if (isOnDemandProvider(source.provider)) {
    return source.error?.code === "subscription_required"
      ? "契約の反映後、⋮ の「更新」で再開できます。"
      : "⋮ の「更新」で取り直せます。";
  }

  return source.error?.code === "subscription_required"
    ? "契約の反映後、⋮ の「利用枠を取得し直す」で再開できます。自動確認は 6 時間ごとです。"
    : `${intervalLabel}後に自動で再試行します。`;
}
