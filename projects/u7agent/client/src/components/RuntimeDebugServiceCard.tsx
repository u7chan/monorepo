import { sessionEntryHref } from "../lib/route";
import type { RuntimeDebugServeState } from "../lib/runtimeDebugServe";
import { messageFullTimeLabel } from "../lib/messageTime";
import { StopIcon } from "./icons";

/** 起動元の会話が引けない行の表示。lease の有無で「追跡外」と「会話の削除」を区別する */
function ownerFallback(command: string | null): string {
  return command === null ? "所有者不明（追跡外）" : "所有者不明（起動元の会話は削除済み）";
}

/**
 * 設定 → ランタイム の「デバッグ用（エージェント内部）」。エージェントの自己検証が使う 127.0.0.1 の
 * 18000 帯を一覧し、強制停止だけを出す (起動・置き換えと、ブラウザーで開く導線は持たない)。
 */
export function RuntimeDebugServiceCard({
  state,
  onStop,
  onOpenSession,
}: {
  state: RuntimeDebugServeState;
  onStop: (port: number) => void;
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
}) {
  const { status, loading, failed, stoppingPort, error } = state;
  const servers = status?.servers ?? [];
  return (
    <section
      className="grid gap-2 rounded-lg border border-line bg-soft p-3"
      aria-label="デバッグ用（エージェント内部）"
    >
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">デバッグ用（エージェント内部）</h3>
      {loading ? (
        <p role="status" className="text-xs text-ink-muted">
          デバッグ用サーバーの状態を取得しています。
        </p>
      ) : failed ? (
        <p role="alert" className="text-xs text-danger-text">
          デバッグ用サーバーの状態を取得できません。接続を確認して再読み込みしてください。
        </p>
      ) : servers.length === 0 ? (
        <p role="status" className="text-xs text-ink-muted">
          デバッグ用のサーバーはありません。
        </p>
      ) : (
        <ul className="grid gap-2">
          {servers.map((entry) => (
            <li key={entry.port} className="grid gap-2 rounded-lg border border-line bg-raised p-2.5">
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-2xs text-ink-faint">待受ポート（サンドボックス側）</dt>
                  <dd className="font-mono text-ink">{entry.port}</dd>
                </div>
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-2xs text-ink-faint">起動元の会話</dt>
                  <dd className="break-all text-ink">
                    {entry.owner ? (
                      <a
                        className="text-accent underline underline-offset-2"
                        href={sessionEntryHref(entry.owner.sessionId, entry.owner.spaceId)}
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
                          if (entry.owner) onOpenSession(entry.owner.sessionId, entry.owner.spaceId);
                        }}
                      >
                        {entry.owner.title || "無題のセッション"}
                      </a>
                    ) : (
                      ownerFallback(entry.command)
                    )}
                  </dd>
                </div>
                {entry.command === null ? null : (
                  <div className="grid min-w-0 gap-0.5 sm:col-span-2">
                    <dt className="text-2xs text-ink-faint">起動コマンド</dt>
                    <dd className="font-mono break-all text-ink">{entry.command}</dd>
                  </div>
                )}
                {entry.startedAt === null ? null : (
                  <div className="grid min-w-0 gap-0.5">
                    <dt className="text-2xs text-ink-faint">起動時刻</dt>
                    <dd className="text-ink">{messageFullTimeLabel(entry.startedAt)}</dd>
                  </div>
                )}
              </dl>
              <div>
                <button
                  type="button"
                  className="btn-quiet border-danger/45 text-danger-text"
                  onClick={() => onStop(entry.port)}
                  disabled={stoppingPort !== null}
                >
                  <StopIcon />
                  {stoppingPort === entry.port ? "停止を確認中…" : "強制停止"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs break-all text-danger-text">
          デバッグ用サーバーの操作に失敗しました: {error}
        </p>
      ) : null}
      <p className="text-2xs leading-relaxed text-ink-muted">
        エージェントの自己検証が 127.0.0.1 の 18000 帯で起動したサーバーです。起動はエージェントの serve
        ツールから行い、ここでは強制停止だけができます。待受していないポートは一覧に出さず、起動元が分からないポートは所有者不明として表示します。
      </p>
    </section>
  );
}
