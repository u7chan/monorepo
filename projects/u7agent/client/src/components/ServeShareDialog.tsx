import { useEffect, useRef, useState } from "react";
import { useLatestRef } from "../hooks/useLatestRef";
import { cn } from "../lib/cn";
import {
  DEFAULT_SERVE_TUNNEL_TTL,
  isShareConfirmationStale,
  isShownStartFailure,
  nextShareConfirmation,
  SERVE_TUNNEL_NOTICE_ITEMS,
  SERVE_TUNNEL_NOTICE_SUMMARY,
  SERVE_TUNNEL_TTL_OPTIONS,
  serveTunnelStopErrorText,
  serveTunnelTargetRows,
  serveTunnelView,
  type ServeShareCandidate,
  type ServeTunnelHandle,
  type ServeTunnelTargetRow,
} from "../lib/serveTunnel";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { ModalDialog, type ModalDialogHandle } from "./ModalDialog";
import { QrCodeView } from "./QrCodeView";
import { SegmentedControl } from "./SegmentedControl";
import { ServeTunnelNoticeLine } from "./ServeTunnelNoticeLine";
import { RunSpinnerIcon, ShareIcon, StopIcon } from "./icons";

export type ServeShareDialogProps = {
  tunnel: ServeTunnelHandle;
  /** 確認に出す対象。共有を始められる状態でなければ null (開始は押せない) */
  candidate: ServeShareCandidate | null;
  onClose: () => void;
};

function TargetList({ rows }: { rows: ServeTunnelTargetRow[] }) {
  return (
    <dl className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-2.5">
      {rows.map((row) => (
        <div key={row.label} className="grid min-w-0 gap-0.5">
          <dt className="text-2xs text-ink-faint">{row.label}</dt>
          <dd className={cn("break-all text-ink", row.mono && "font-mono")}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 一時共有の 1 つのダイアログ。確認 → 起動中 → 共有中を、サーバーの状態から描き分ける。
 * 閉じても共有は続き (Escape も同じ)、開き直すとサーバーの状態から復元する。
 */
export function ServeShareDialog({ tunnel, candidate, onClose }: ServeShareDialogProps) {
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const live = useLatestRef(candidate);
  const view = serveTunnelView(tunnel.state);
  const [ttl, setTtl] = useState(DEFAULT_SERVE_TUNNEL_TTL);
  // 確認は見せた時点の対象で行い、ポーリングで差し替わった別のアプリは、確認し直すまで共有させない
  const [confirmed, setConfirmed] = useState(candidate);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // 主操作は取り消しにくい公開なので、開いたときの Enter で確定させない側に焦点を置く
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // 共有が始まったら、前の開始の失敗は古い。共有が終わって確認へ戻ったときに出し直さない
  useEffect(() => {
    if (view.sharing) setFailure(undefined);
  }, [view.sharing]);

  // 開始の失敗はこの画面が表示済み。終了の通知として重ねず、閉じたあとにも残さない
  const { dismissNotice } = tunnel;
  const shownFailure = isShownStartFailure(tunnel.notice, failure);
  useEffect(() => {
    if (shownFailure) dismissNotice();
  }, [shownFailure, dismissNotice]);

  const confirming = !view.sharing;
  const stale = isShareConfirmationStale(confirmed, candidate);
  const canStart = view.phase === "idle" && confirmed !== null && candidate !== null && !stale;
  const start = async (): Promise<void> => {
    if (!canStart) return;
    setFailure(undefined);
    const result = await tunnel.start({ generation: confirmed.generation, ttlMinutes: ttl });
    if (result.kind === "failed") setFailure(result.error);
    setConfirmed((current) => nextShareConfirmation(current, live.current, result));
  };
  const stopError = serveTunnelStopErrorText(tunnel.state.stopError);

  return (
    <ModalDialog
      frame="sheet"
      label="一時共有"
      ariaBusy={view.phase === "starting"}
      handleRef={shellRef}
      onClosed={onClose}
      className="flex flex-col"
    >
      <header className="shrink-0 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-strong">一時共有</h2>
        <p className="text-2xs text-ink-muted">動いているサービスを、期限つきの URL で外へ見せます。</p>
      </header>

      <div className="grid min-h-0 scrollbar-thin content-start gap-3 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
        {view.phase === "starting" ? (
          <>
            <p role="status" className="flex items-center gap-1.5 text-ink-soft">
              <RunSpinnerIcon />
              共有を準備しています…
            </p>
            <p className="text-1xs break-words text-ink-muted">
              Cloudflare に接続して URL を作っています。この画面を閉じても準備は続きます。
            </p>
          </>
        ) : null}

        {view.active === null ? null : (
          <>
            <QrCodeView url={view.active.url} />
            <p className="font-semibold text-ink">{view.badge}</p>
            <TargetList rows={serveTunnelTargetRows(view.active.target)} />
            <p className="text-1xs break-words text-ink-muted">
              この画面を閉じても共有は続きます。止めるまで、または期限まで URL は有効です。
            </p>
          </>
        )}

        {view.stale ? (
          <p role="status" className="text-1xs break-words text-warn">
            最新の状態を取得できていません。表示は最後に確認した内容です。
          </p>
        ) : null}
        {stopError === undefined ? null : (
          <p role="alert" className="text-1xs break-words text-danger-text">
            {stopError}
          </p>
        )}

        {confirming ? (
          <>
            {tunnel.notice === null || shownFailure ? null : (
              <ServeTunnelNoticeLine notice={tunnel.notice} onDismiss={tunnel.dismissNotice} />
            )}
            {view.phase === "unknown" ? (
              <p role={tunnel.state.failed ? "alert" : "status"} className="break-words text-ink-soft">
                {tunnel.state.failed
                  ? "共有の状態を取得できません。接続を確認して再読み込みしてください。"
                  : "共有の状態を取得しています…"}
              </p>
            ) : null}
            {view.phase === "unavailable" ? (
              <p role="status" className="break-words text-warn">
                {view.unavailableReason ?? "一時共有を使えません。"}
              </p>
            ) : null}
            {view.phase === "idle" && candidate === null ? (
              <p role="status" className="break-words text-warn">
                共有できるサービスがありません。サービスが稼働していることを確認してください。
              </p>
            ) : null}
            {view.phase === "idle" && candidate !== null && stale ? (
              <div role="status" className="grid gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2.5">
                <p className="break-words text-warn">
                  共有するサービスの状態が変わりました。最新の内容で確認し直してください。
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmed(candidate)}
                  className="btn-quiet w-fit singleColumn:min-h-11"
                >
                  最新の内容を表示
                </button>
              </div>
            ) : null}
            {view.phase === "idle" && confirmed !== null && candidate !== null && !stale ? (
              <>
                <TargetList rows={serveTunnelTargetRows(confirmed.target)} />
                <div className="grid gap-1">
                  <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">共有の期限</span>
                  <SegmentedControl
                    ariaLabel="共有の期限"
                    size="comfortable"
                    items={SERVE_TUNNEL_TTL_OPTIONS}
                    value={ttl}
                    onChange={setTtl}
                  />
                </div>
                <CollapsibleNotice summary={SERVE_TUNNEL_NOTICE_SUMMARY}>
                  {SERVE_TUNNEL_NOTICE_ITEMS.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </CollapsibleNotice>
              </>
            ) : null}
            {failure === undefined ? null : (
              <p role="alert" className="break-words text-danger-text">
                {failure}
              </p>
            )}
          </>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
        <button
          ref={closeRef}
          type="button"
          onClick={() => shellRef.current?.requestClose()}
          className="btn-quiet singleColumn:min-h-11"
        >
          {confirming ? "キャンセル" : "閉じる"}
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={!canStart}
            className="btn-primary singleColumn:min-h-11"
          >
            <ShareIcon />
            共有を開始
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void tunnel.stop()}
            disabled={tunnel.state.stopping}
            className="btn-quiet border-danger/45 text-danger-text singleColumn:min-h-11"
          >
            <StopIcon />
            {tunnel.state.stopping ? "停止しています…" : view.stopLabel}
          </button>
        )}
      </footer>
    </ModalDialog>
  );
}
