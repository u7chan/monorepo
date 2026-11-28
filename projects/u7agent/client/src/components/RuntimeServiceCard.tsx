import { cn } from "../lib/cn";
import { sessionEntryHref } from "../lib/route";
import type { RuntimeServeState } from "../lib/runtimeServe";
import { runtimeShareCandidate, type ServeTunnelEntry } from "../lib/serveTunnel";
import { servedAppUrl } from "../lib/servedApp";
import { ServeTunnelNoticeLine } from "./ServeTunnelNoticeLine";
import { ExternalLinkIcon, QrCodeIcon, RunSpinnerIcon, ShareIcon, StopIcon } from "./icons";

/**
 * 一時共有の区画。サービスの到達可否や取得の失敗とは独立に置き、共有中の表示と停止を消さない
 * (止めた途端に消えると、期限まで続く共有の消し忘れを防げない)。
 */
function RuntimeShareSection({ tunnel, canShare }: { tunnel: ServeTunnelEntry; canShare: boolean }) {
  const { view } = tunnel;
  if (!view.sharing && !canShare && tunnel.notice === null && tunnel.error === undefined) return null;
  const unavailable = view.phase === "unavailable";
  return (
    <div role="group" aria-label="一時共有" className="grid gap-2 border-t border-line pt-2">
      <h4 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">一時共有</h4>
      {tunnel.notice === null ? null : (
        <ServeTunnelNoticeLine notice={tunnel.notice} onDismiss={tunnel.onDismissNotice} />
      )}
      {view.sharing ? (
        <p className="flex items-center gap-1.5 text-xs text-ink">
          {view.phase === "starting" ? <RunSpinnerIcon /> : <span aria-hidden="true" className="dot dot-accent" />}
          {view.badge}
        </p>
      ) : null}
      {view.stale ? (
        <p role="status" className="text-2xs text-warn">
          最新の状態を取得できていません。表示は最後に確認した内容です。
        </p>
      ) : null}
      {view.sharing || canShare ? (
        // 先頭の button は始める入口と共有の画面で同じ要素にする (ダイアログを閉じた焦点の戻り先を残す)
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-quiet" onClick={tunnel.onOpen} disabled={!view.sharing && unavailable}>
            {view.sharing ? <QrCodeIcon /> : <ShareIcon />}
            {view.sharing ? "共有の画面を開く" : "一時共有…"}
          </button>
          {view.sharing ? (
            <button
              type="button"
              className="btn-quiet border-danger/45 text-danger-text"
              onClick={tunnel.onStop}
              disabled={tunnel.stopping}
            >
              <StopIcon />
              {tunnel.stopping ? "停止しています…" : view.stopLabel}
            </button>
          ) : (
            <p className="min-w-0 text-2xs break-words text-ink-muted">
              {unavailable
                ? (view.unavailableReason ?? "一時共有を使えません。")
                : "動いているサービスを、期限つきの URL で外へ共有します。"}
            </p>
          )}
        </div>
      ) : null}
      {tunnel.error === undefined ? null : (
        <p role="alert" className="text-xs break-all text-danger-text">
          {tunnel.error}
        </p>
      )}
    </div>
  );
}

export function RuntimeServiceCard({
  state,
  hostname,
  port,
  serviceOrigin,
  tunnel,
  onStop,
  onOpenSession,
}: {
  state: RuntimeServeState;
  hostname: string;
  port?: number;
  /** ブラウザから見たサービス オリジン (health の serviceOrigin)。設定済みならポートより優先する */
  serviceOrigin?: string;
  /** 一時共有。サービスの状態とは独立に出す */
  tunnel: ServeTunnelEntry;
  onStop: () => void;
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
}) {
  const { status, loading, failed, stopping, error } = state;
  const href = status?.reachable ? servedAppUrl(hostname, port, serviceOrigin) : undefined;
  // 誰が起動したアプリでも対象にする。サービスの操作中は世代が動くので、落ち着くまで始めさせない
  const canShare = !failed && !stopping && state.starting === null && runtimeShareCandidate(status) !== null;
  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3" aria-label="公開中のサービス">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">公開中のサービス</h3>
      {loading ? (
        <p role="status" className="text-xs text-ink-muted">
          サービスの状態を取得しています。
        </p>
      ) : failed ? (
        <p role="alert" className="text-xs text-danger-text">
          サービスの状態を取得できません。接続を確認して再読み込みしてください。
        </p>
      ) : status ? (
        <>
          <p role="status" className="flex items-center gap-1.5 text-xs text-ink">
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", status.reachable ? "bg-ok" : "bg-ink-ghost")}
            />
            {status.reachable ? "稼働中" : "停止中"}
          </p>
          {status.reachable ? (
            <>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-2xs text-ink-faint">起動元の会話</dt>
                  <dd className="break-all text-ink">
                    {status.owner ? (
                      <a
                        className="text-accent underline underline-offset-2"
                        href={sessionEntryHref(status.owner.sessionId, status.owner.spaceId)}
                        onClick={(event) => {
                          if (
                            !onOpenSession ||
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          if (status.owner) onOpenSession(status.owner.sessionId, status.owner.spaceId);
                        }}
                      >
                        {status.owner.title || "無題のセッション"}
                      </a>
                    ) : (
                      "起動元不明"
                    )}
                  </dd>
                </div>
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-2xs text-ink-faint">待受ポート（サンドボックス側）</dt>
                  <dd className="text-ink">8080</dd>
                </div>
                {status.command ? (
                  <>
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="text-2xs text-ink-faint">作業ディレクトリ（ワークスペース相対）</dt>
                      <dd className="font-mono break-all text-ink">{status.command.cwd || "."}</dd>
                    </div>
                    <div className="grid min-w-0 gap-0.5">
                      <dt className="text-2xs text-ink-faint">起動コマンド</dt>
                      <dd className="font-mono break-all text-ink">{status.command.command}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer noopener" className="btn-quiet">
                    <ExternalLinkIcon />
                    ページを開く
                  </a>
                ) : null}
                {status.generation ? (
                  <button
                    type="button"
                    className="btn-quiet border-danger/45 text-danger-text"
                    onClick={onStop}
                    disabled={stopping}
                  >
                    <StopIcon />
                    {stopping ? "停止を確認中…" : "停止"}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-ink-muted">現在公開中のサービスはありません。</p>
          )}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs break-all text-danger-text">
          サービスの操作に失敗しました: {error}
        </p>
      ) : null}
      <RuntimeShareSection tunnel={tunnel} canShare={canShare} />
      <p className="text-2xs leading-relaxed text-ink-muted">
        公開枠は全会話で共有の1本です。状態は4秒ごとに更新します。稼働中はポートへの接続可否を示し、ページの正常動作を保証するものではありません。
      </p>
    </section>
  );
}
