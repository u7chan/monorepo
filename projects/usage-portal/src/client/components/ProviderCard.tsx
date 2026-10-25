import type { CodexAuthState, ProviderUsage } from "../api";
import { formatClock } from "../lib/format";
import { deriveProviderStatus, showsWindows } from "../lib/status";
import { CodexAuthPanel, type CodexActions } from "./CodexAuthPanel";
import { OpenCodeAuthPanel, type OpenCodeActions, type OpenCodeConnection } from "./OpenCodeAuthPanel";
import { StatusLabel } from "./StatusLabel";
import { TrendChart } from "./Trend";
import { UsageMeter } from "./UsageMeter";

export function ProviderCard(props: {
  provider: ProviderUsage;
  now: number;
  codex?: { auth: CodexAuthState | null; actions: CodexActions };
  opencode?: { connection: OpenCodeConnection; actions: OpenCodeActions };
}) {
  const { provider } = props;
  const status = deriveProviderStatus({
    id: provider.id,
    state: provider.state,
    errorCode: provider.error?.code ?? null,
    limitReached: provider.limitReached,
    usedPercents: provider.windows.map((window) => window.usedPercent),
  });
  const showMeters = showsWindows(provider.state) && provider.windows.length > 0;
  const trendLabel = provider.trend
    ? (provider.windows.find((window) => window.id === provider.trend?.windowId)?.label ?? provider.trend.windowId)
    : null;

  return (
    <article class="up-card up-provider">
      <header class="up-provider-head">
        <div class="up-provider-title">
          <h2 class="up-provider-name">{provider.name}</h2>
          {provider.plan ? <span class="up-caption">{provider.plan}</span> : null}
        </div>
        <StatusLabel status={status} />
      </header>

      {provider.state === "loading" ? <p class="up-caption">利用枠を取得しています。</p> : null}

      {showMeters ? (
        <div class="up-meters">
          {provider.windows.map((window) => (
            <UsageMeter key={window.id} window={window} now={props.now} />
          ))}
        </div>
      ) : null}

      {provider.state === "stale" ? (
        <div class="up-empty">
          <p class="up-caption">前回取得した値を表示しています。</p>
          {provider.error ? <p class="up-caption">{provider.error.message}</p> : null}
          <p class="up-caption">5 分後に自動で再試行します。</p>
        </div>
      ) : null}

      {provider.state === "error" ? (
        <div class="up-empty">
          <p class="up-caption">{provider.error ? provider.error.message : "利用枠を取得できませんでした。"}</p>
          <p class="up-caption">5 分後に自動で再試行します。</p>
        </div>
      ) : null}

      {provider.notes.length > 0 ? (
        <ul class="up-notes">
          {provider.notes.map((note) => (
            <li class="up-caption" key={note}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {provider.trend && trendLabel && showMeters ? <TrendChart trend={provider.trend} label={trendLabel} /> : null}

      <footer class="up-provider-foot">
        <p class="up-caption">
          {provider.capturedAt === null ? "まだ取得していません" : `最終取得 ${formatClock(provider.capturedAt)}`}
        </p>
      </footer>

      {props.codex ? (
        <CodexAuthPanel
          auth={props.codex.auth}
          actions={props.codex.actions}
          needsSignIn={provider.error?.code === "not_connected" || provider.error?.code === "reauth_required"}
        />
      ) : null}

      {props.opencode ? (
        <OpenCodeAuthPanel connection={props.opencode.connection} actions={props.opencode.actions} />
      ) : null}
    </article>
  );
}
