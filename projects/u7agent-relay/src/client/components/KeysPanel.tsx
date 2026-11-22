import { useEffect, useState } from "preact/hooks";
import { createKey, deleteKey, revokeKey, type ConnectionView, type KeyView } from "../api";
import { formatDateTime, formatRelative } from "../format";

const STATUS_LABELS: Record<string, string> = {
  running: "実行中",
  awaiting_answer: "回答待ち",
  completed: "完了",
  stopped: "停止",
  error: "エラー",
};

export function KeysPanel(props: {
  connections: ConnectionView[];
  keys: KeyView[];
  reload: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState(props.connections[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // 接続先を消した後も選択が残ると、キー作成が 400 になる。選択肢が無くなったら戻す。
  useEffect(() => {
    if (!props.connections.some((connection) => connection.id === connectionId)) {
      setConnectionId(props.connections[0]?.id ?? "");
    }
  }, [connectionId, props.connections]);

  const connectionName = (id: string): string =>
    props.connections.find((connection) => connection.id === id)?.name ?? "削除済みの接続先";

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setCopied(false);

    try {
      const result = await createKey(name, connectionId);
      setCreated({ token: result.token, name: result.key.name });
      setName("");
      await props.reload();
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) {
      return;
    }

    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      props.onError(new Error("クリップボードへコピーできませんでした。選択してコピーしてください。"));
    }
  };

  const revoke = async (key: KeyView) => {
    if (!window.confirm(`「${key.name}」を失効させます。このキーを使う外部クライアントは即座に 401 になります。`)) {
      return;
    }

    try {
      await revokeKey(key.id);
      await props.reload();
    } catch (error) {
      props.onError(error);
    }
  };

  const remove = async (key: KeyView) => {
    if (!window.confirm(`「${key.name}」を削除します。実行履歴のキー名は「削除済み」になります。`)) {
      return;
    }

    try {
      await deleteKey(key.id);
      await props.reload();
    } catch (error) {
      props.onError(error);
    }
  };

  return (
    <section class="panel">
      <div class="panel-head">
        <h2>API キー</h2>
        <p class="muted">
          外部クライアントは <span class="mono">Authorization: Bearer &lt;token&gt;</span>{" "}
          で投稿します。平文は発行直後だけ表示します。
        </p>
      </div>

      {props.connections.length === 0 ? (
        <p class="empty">先に接続先を登録してください。</p>
      ) : (
        <div class="card">
          <form class="form-grid" onSubmit={submit}>
            <label class="field">
              <span>名前</span>
              <input
                value={name}
                maxLength={64}
                required
                placeholder="例: Muse"
                onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="field">
              <span>接続先</span>
              <select
                value={connectionId}
                onChange={(event) => setConnectionId((event.currentTarget as HTMLSelectElement).value)}
              >
                {props.connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </label>
            <div class="actions">
              <button class="button primary" type="submit" disabled={busy}>
                {busy ? "発行中…" : "キーを発行する"}
              </button>
            </div>
          </form>
        </div>
      )}

      {created ? (
        <div class="card token-card">
          <p>
            <strong>{created.name}</strong>{" "}
            のキーを発行しました。この値をクライアントへ設定してください。再表示はできません。
          </p>
          <div class="token-row">
            <code class="token">{created.token}</code>
            <button class="button small" type="button" onClick={() => void copy()}>
              {copied ? "コピーしました" : "コピー"}
            </button>
            <button class="button small" type="button" onClick={() => setCreated(null)}>
              閉じる
            </button>
          </div>
        </div>
      ) : null}

      {props.keys.length === 0 ? (
        <p class="empty">API キーはまだありません。</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>接続先</th>
                <th>prefix</th>
                <th>最終使用</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <strong>{key.name}</strong>
                    <div class="sub">{formatDateTime(key.createdAt)} に発行</div>
                  </td>
                  <td>{connectionName(key.connectionId)}</td>
                  <td>
                    <span class="mono">{key.prefix}…</span>
                  </td>
                  <td>{formatRelative(key.lastUsedAt)}</td>
                  <td>
                    {key.revokedAt === null ? (
                      <span class="badge ok">有効</span>
                    ) : (
                      <span class="badge error">失効</span>
                    )}
                  </td>
                  <td class="row-actions">
                    {key.revokedAt === null ? (
                      <button class="button small" type="button" onClick={() => void revoke(key)}>
                        失効
                      </button>
                    ) : null}
                    <button class="button small danger" type="button" onClick={() => void remove(key)}>
                      削除
                    </button>
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

export function runStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
