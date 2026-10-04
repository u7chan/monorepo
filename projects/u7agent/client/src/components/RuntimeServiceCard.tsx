import { cn } from "../lib/cn";
import { routePath } from "../lib/route";
import type { RuntimeServeState } from "../lib/runtimeServe";
import { servedAppUrl } from "../lib/servedApp";
import { ExternalLinkIcon, StopIcon } from "./icons";

export function RuntimeServiceCard({
  state,
  hostname,
  port,
  onStop,
  onOpenSession,
}: {
  state: RuntimeServeState;
  hostname: string;
  port?: number;
  onStop: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { status, loading, failed, stopping, error } = state;
  const href = status?.reachable ? servedAppUrl(hostname, port) : undefined;
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
                        href={routePath({ view: "chat", pendingSessionId: status.owner.sessionId })}
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
                          if (status.owner) onOpenSession(status.owner.sessionId);
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
      <p className="text-2xs leading-relaxed text-ink-muted">
        公開枠は全会話で共有の1本です。状態は4秒ごとに更新します。稼働中はポートへの接続可否を示し、ページの正常動作を保証するものではありません。
      </p>
    </section>
  );
}
