import type { ConnectionView, RunView } from "../api";
import { formatDateTime, shortRunId } from "../format";
import { runStatusLabel } from "./KeysPanel";

export function RunsPanel(props: { connections: ConnectionView[]; runs: RunView[] }) {
  const connectionName = (id: string): string =>
    props.connections.find((connection) => connection.id === id)?.name ?? "削除済みの接続先";

  return (
    <section class="panel">
      <div class="panel-head">
        <h2>実行履歴</h2>
        <p class="muted">この中継が受け付けた直近 50 件です。結果の本文は完了時だけ保存します。</p>
      </div>

      {props.runs.length === 0 ? (
        <p class="empty">まだ実行はありません。</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>受付</th>
                <th>接続先</th>
                <th>キー</th>
                <th>実行 ID</th>
                <th>状態</th>
                <th>応答</th>
              </tr>
            </thead>
            <tbody>
              {props.runs.map((run) => (
                <tr key={run.runId}>
                  <td>{formatDateTime(run.createdAt)}</td>
                  <td>{connectionName(run.connectionId)}</td>
                  <td>{run.keyName ?? "削除済み"}</td>
                  <td>
                    <span class="mono" title={run.runId}>
                      {shortRunId(run.runId)}
                    </span>
                  </td>
                  <td>
                    <span
                      class={`badge ${run.status === "completed" ? "ok" : run.status === "error" ? "error" : "warn"}`}
                    >
                      {runStatusLabel(run.status)}
                    </span>
                  </td>
                  <td class="preview">
                    {run.text ? run.text.replace(/\s+/g, " ").slice(0, 80) : <span class="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
