import { useState } from "preact/hooks";
import type { CodexAuthState, UsageSource } from "../api";
import { formatClock } from "../lib/format";
import { deriveProviderStatus, showsWindows } from "../lib/status";
import { pickTrendWindow } from "../lib/windows";
import { AccountIcon } from "./AccountIcon";
import { CodexAuthPanel, type CodexActions } from "./CodexAuthPanel";
import { OpenCodeAccountPanel } from "./OpenCodeAccountPanel";
import type { OpenCodeAccountActions } from "./OpenCodeAccountForm";
import { StatusLabel } from "./StatusLabel";
import { TrendChart } from "./Trend";
import { UsageMeter } from "./UsageMeter";

export function ProviderCard(props: {
  source: UsageSource;
  now: number;
  /** 推移の右端。再取得のたびにグラフが横にずれないよう、描画時刻ではなく応答時刻を使う。 */
  generatedAt: number | null;
  codex?: { auth: CodexAuthState | null; actions: CodexActions };
  opencode?: { actions: OpenCodeAccountActions };
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
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const activeWindow = chartWindows.find((window) => window.id === selectedWindowId) ?? pickTrendWindow(chartWindows);
  const activeTrend = activeWindow ? (source.trends.find((trend) => trend.windowId === activeWindow.id) ?? null) : null;

  return (
    <article class="up-card up-provider">
      <header class="up-provider-head">
        <div class="up-provider-title">
          {source.account ? <AccountIcon id={source.account.id} icon={source.account.icon} /> : null}
          <h2 class="up-provider-name">{source.name}</h2>
          {source.account ? (
            <span class="up-caption">OpenCode Go</span>
          ) : source.plan ? (
            <span class="up-caption">{source.plan}</span>
          ) : null}
        </div>
        <StatusLabel status={status} />
      </header>

      {source.state === "loading" ? <p class="up-caption">利用枠を取得しています。</p> : null}

      {showMeters ? (
        <div class="up-meters">
          {source.windows.map((window) => (
            <UsageMeter key={window.id} window={window} now={props.now} />
          ))}
        </div>
      ) : null}

      {source.state === "stale" ? (
        <div class="up-empty">
          <p class="up-caption">前回取得した値を表示しています。</p>
          {source.error ? <p class="up-caption">{source.error.message}</p> : null}
          <p class="up-caption">5 分後に自動で再試行します。</p>
        </div>
      ) : null}

      {source.state === "error" ? (
        <div class="up-empty">
          <p class="up-caption">{source.error ? source.error.message : "利用枠を取得できませんでした。"}</p>
          <p class="up-caption">5 分後に自動で再試行します。</p>
        </div>
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

      {activeWindow ? (
        <TrendChart
          windows={chartWindows}
          activeWindowId={activeWindow.id}
          trend={activeTrend}
          generatedAt={props.generatedAt}
          onSelect={setSelectedWindowId}
        />
      ) : null}

      <footer class="up-provider-foot">
        <p class="up-caption">
          {source.capturedAt === null ? "まだ取得していません" : `最終取得 ${formatClock(source.capturedAt)}`}
        </p>
      </footer>

      {props.codex ? (
        <CodexAuthPanel
          auth={props.codex.auth}
          actions={props.codex.actions}
          needsSignIn={source.error?.code === "not_connected" || source.error?.code === "reauth_required"}
        />
      ) : null}

      {props.opencode && source.account ? (
        <OpenCodeAccountPanel account={source.account} actions={props.opencode.actions} />
      ) : null}
    </article>
  );
}
