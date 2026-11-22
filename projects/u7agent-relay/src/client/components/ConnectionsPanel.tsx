import { useState } from "preact/hooks";
import {
  addConnection,
  checkConnection,
  createConnection,
  deleteConnection,
  describeError,
  updateConnection,
  type CheckResult,
  type ConnectionView,
} from "../api";
import { formatDateTime } from "../format";

type CheckState = CheckResult | { error: string } | "checking";

export function ConnectionsPanel(props: {
  connections: ConnectionView[];
  reload: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [mode, setMode] = useState<"url" | "create">("url");
  const [name, setName] = useState("");
  const [sessionUrl, setSessionUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [spaceId, setSpaceId] = useState("default");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);

    try {
      if (mode === "url") {
        await addConnection(name, sessionUrl);
      } else {
        await createConnection(name, origin, spaceId);
      }

      setName("");
      setSessionUrl("");
      setOrigin("");
      setSpaceId("default");
      await props.reload();
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(false);
    }
  };

  const check = async (id: string) => {
    setChecks((current) => ({ ...current, [id]: "checking" }));

    try {
      const result = await checkConnection(id);
      setChecks((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setChecks((current) => ({ ...current, [id]: { error: describeError(error) } }));
    }
  };

  const remove = async (connection: ConnectionView) => {
    if (!window.confirm(`「${connection.name}」を削除します。紐づく API キーも削除されます。よろしいですか？`)) {
      return;
    }

    try {
      await deleteConnection(connection.id);
      await props.reload();
    } catch (error) {
      props.onError(error);
    }
  };

  const saveEdit = async (event: Event) => {
    event.preventDefault();

    if (!editing) {
      return;
    }

    setBusy(true);

    try {
      await updateConnection(editing.id, editing.name);
      setEditing(null);
      await props.reload();
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <div class="panel-head">
        <h2>接続先</h2>
        <p class="muted">1 つの接続先が u7agent の 1 会話に対応します。API キーは接続先に紐づきます。</p>
      </div>

      <div class="card">
        <div class="tabs small">
          <button type="button" class={mode === "url" ? "tab active" : "tab"} onClick={() => setMode("url")}>
            会話 URL を貼る
          </button>
          <button type="button" class={mode === "create" ? "tab active" : "tab"} onClick={() => setMode("create")}>
            新しい会話を作る
          </button>
        </div>
        <form class="form-grid" onSubmit={submit}>
          <label class="field">
            <span>名前</span>
            <input
              value={name}
              maxLength={64}
              required
              placeholder="例: 開発機の調査用"
              onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {mode === "url" ? (
            <label class="field wide">
              <span>会話 URL</span>
              <input
                value={sessionUrl}
                required
                placeholder="https://agent.example.com/s/0123456789?space=default"
                onInput={(event) => setSessionUrl((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          ) : (
            <>
              <label class="field wide">
                <span>u7agent の origin</span>
                <input
                  value={origin}
                  required
                  placeholder="https://agent.example.com"
                  onInput={(event) => setOrigin((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>スペース ID</span>
                <input
                  value={spaceId}
                  placeholder="default"
                  onInput={(event) => setSpaceId((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
            </>
          )}
          <div class="actions">
            <button class="button primary" type="submit" disabled={busy}>
              {busy ? "処理中…" : mode === "url" ? "登録する" : "作成して登録する"}
            </button>
          </div>
        </form>
      </div>

      {editing ? (
        <div class="card edit-card">
          <form class="form-grid" onSubmit={saveEdit}>
            <label class="field">
              <span>名前</span>
              <input
                value={editing.name}
                maxLength={64}
                required
                onInput={(event) => setEditing({ ...editing, name: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <p class="muted wide">会話を変えるときは、新しい接続先を登録してキーを発行し直してください。</p>
            <div class="actions">
              <button class="button primary" type="submit" disabled={busy}>
                保存
              </button>
              <button class="button" type="button" onClick={() => setEditing(null)}>
                キャンセル
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {props.connections.length === 0 ? (
        <p class="empty">接続先はまだありません。</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>会話</th>
                <th>キー</th>
                <th>疎通</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.connections.map((connection) => {
                const state = checks[connection.id];

                return (
                  <tr key={connection.id}>
                    <td>
                      <strong>{connection.name}</strong>
                      <div class="sub">{formatDateTime(connection.createdAt)} に登録</div>
                    </td>
                    <td>
                      <span class="mono">{connection.sessionId}</span>
                      <div class="sub">space: {connection.spaceId}</div>
                    </td>
                    <td>{connection.keyCount}</td>
                    <td>
                      {state === undefined ? (
                        <span class="muted">未確認</span>
                      ) : state === "checking" ? (
                        <span class="muted">確認中…</span>
                      ) : "error" in state ? (
                        <span class="badge error">{state.error}</span>
                      ) : (
                        <>
                          <span class={`badge ${statusTone(state.status)}`}>{state.status}</span>
                          <div class="sub">
                            {state.title ?? "無題"} / 待ち {state.queueDepth}
                          </div>
                        </>
                      )}
                    </td>
                    <td class="row-actions">
                      <button class="button small" type="button" onClick={() => void check(connection.id)}>
                        疎通確認
                      </button>
                      <button
                        class="button small"
                        type="button"
                        onClick={() => setEditing({ id: connection.id, name: connection.name })}
                      >
                        編集
                      </button>
                      <button class="button small danger" type="button" onClick={() => void remove(connection)}>
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function statusTone(status: string): string {
  if (status === "idle" || status === "completed") {
    return "ok";
  }

  if (status === "running" || status === "awaiting_answer") {
    return "warn";
  }

  return "error";
}
