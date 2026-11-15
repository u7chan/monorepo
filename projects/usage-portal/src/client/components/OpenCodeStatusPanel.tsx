import { useEffect, useId, useState } from "preact/hooks";
import { OPENCODE_STATUS_PAGE_URL, statusIsOld } from "../../shared/opencode-status";
import { type OpenCodeStatusPayload, fetchOpenCodeStatus } from "../api";
import { formatDateTime } from "../lib/format";
import {
  deriveOpenCodeStatus,
  mergeOpenCodeStatusPayload,
  serviceStatusLabel,
  statusReasonLabel,
} from "../lib/opencode-status";
import { StatusLabel } from "./StatusLabel";

export function OpenCodeStatusPanel(props: { now: number; onUnauthorized: () => void }) {
  const [payload, setPayload] = useState<OpenCodeStatusPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { onUnauthorized } = props;

  useEffect(() => {
    let disposed = false;
    let loading = false;

    const load = async (): Promise<void> => {
      if (loading) {
        return;
      }

      loading = true;

      try {
        const result = await fetchOpenCodeStatus();

        if (disposed) {
          return;
        }

        if (result && "unauthorized" in result) {
          onUnauthorized();

          return;
        }

        if (result) {
          setPayload((current) => mergeOpenCodeStatusPayload(current, result));

          return;
        }
      } catch {
        // 通信失敗を Go の障害とは断定しない。前回値があれば古い情報として残す。
      } finally {
        loading = false;
      }

      if (!disposed) {
        setPayload((current) => mergeOpenCodeStatusPayload(current, null));
      }
    };

    void load();

    const timer = setInterval(() => void load(), 60_000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [onUnauthorized]);

  const status = deriveOpenCodeStatus(payload, props.now);
  const snapshot = payload?.snapshot;
  const reason = snapshot ? statusReasonLabel(snapshot.reason) : null;
  const affected = snapshot?.models.filter((model) => model.status === "degraded" || model.status === "outage") ?? [];
  const stale = !!snapshot && (payload?.state === "stale" || statusIsOld(snapshot, props.now));

  return (
    <section class="up-service-status" data-stale={stale} data-expanded={expanded} aria-label="OpenCode Go の稼働状況">
      <h2 class="up-service-status-head up-subheading">
        <button
          class="up-service-status-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span class="up-subheading">OpenCode Go 稼働状況</span>
          <span role="status">
            <StatusLabel status={status} />
          </span>
          <svg class="up-service-status-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </h2>
      <div class="up-service-status-content" id={contentId} aria-hidden={!expanded} inert={!expanded}>
        <div class="up-service-status-clip">
          <div class="up-service-status-body">
            {snapshot ? (
              <>
                <p class="up-caption">
                  {stale
                    ? `最新情報を確認できません。前回の状態: ${serviceStatusLabel(snapshot.status).label}。`
                    : "Go の主要モデルの状態。"}
                  {reason ? ` ${reason}。` : ""}
                  {affected.length > 0 ? ` 対象: ${affected.map((model) => model.id).join("、")}` : ""}
                </p>
                <p class="up-caption">
                  公式更新 {formatDateTime(snapshot.updatedAt)} · 利用枠・契約状態とは別の情報です
                </p>
                {snapshot.models.length > 0 || snapshot.incidents.length > 0 ? (
                  <div class="up-service-status-details">
                    <p class="up-caption">
                      {stale ? "前回のモデル別の状態" : "モデル別の状態"}・進行中のインシデント（
                      {snapshot.incidents.length} 件）
                    </p>
                    <ul class="up-service-status-list">
                      {snapshot.models.map((model) => (
                        <li key={model.id}>
                          <span class="up-caption">{model.id}</span>
                          <StatusLabel status={serviceStatusLabel(model.status)} />
                          {model.reason !== "none" ? (
                            <span class="up-caption">{statusReasonLabel(model.reason)}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {snapshot.incidents.map((incident) => (
                      <p class="up-caption" key={incident.startedAt}>
                        {formatDateTime(incident.startedAt)} 開始 ·{" "}
                        {statusReasonLabel(incident.reason) ?? serviceStatusLabel(incident.status).label}
                        {incident.models.length > 0 ? ` · ${incident.models.join("、")}` : ""}
                        {snapshot.status === "operational" ? " · 復旧後の監視中" : ""}
                      </p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p class="up-caption">
                {payload ? "稼働状況を取得できません。公式ページで確認してください。" : "稼働状況を取得しています。"}
              </p>
            )}
            <a class="up-link up-caption" href={OPENCODE_STATUS_PAGE_URL} target="_blank" rel="noopener noreferrer">
              公式ステータス ↗
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
