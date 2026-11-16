import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MASTER_KINDS, type CostMasterPayload, type MasterKind } from "../shared/contract";
import { formatCost, formatFetchedAt } from "../shared/format";
import { fetchModels, masterDownloadUrl, uploadMaster } from "./api";
import { groupByModel, summarize, type ModelGroup } from "./models";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; payload: CostMasterPayload };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    setState({ status: "loading" });

    fetchModels(controller.signal)
      .then((payload) => setState({ status: "ok", payload }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({ status: "error", message: error instanceof Error ? error.message : "マスタを取得できませんでした" });
      });

    return () => controller.abort();
  }, [nonce]);

  return (
    <main class="page">
      <header class="head">
        <h1>Cost Master</h1>
        <p class="lead">
          コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断。マスタは下の欄からアップロードすると
          再起動なしで反映される。
        </p>
        {state.status === "ok" ? <Summary payload={state.payload} /> : null}
      </header>

      {state.status === "loading" ? <p class="note">読み込み中…</p> : null}
      {state.status === "error" ? <p class="note error">{state.message}</p> : null}
      {state.status === "ok" ? <ModelList payload={state.payload} /> : null}

      <MasterUpload onUploaded={reload} />
    </main>
  );
}

function Summary({ payload }: { payload: CostMasterPayload }) {
  const summary = summarize(payload.models);

  return (
    <dl class="summary">
      <div>
        <dt>モデル</dt>
        <dd>{summary.models}</dd>
      </div>
      <div>
        <dt>価格行</dt>
        <dd>{summary.rows}</dd>
      </div>
      <div>
        <dt>一覧に出さない</dt>
        <dd>{summary.hidden}</dd>
      </div>
      <div>
        <dt>世代</dt>
        <dd>v{payload.version}</dd>
      </div>
      <div>
        <dt>価格の取得</dt>
        <dd>{formatFetchedAt(payload.fetchedAt)}</dd>
      </div>
    </dl>
  );
}

function ModelList({ payload }: { payload: CostMasterPayload }) {
  const groups = groupByModel(payload.models);

  if (groups.length === 0) {
    return <p class="note">価格が宣言されているモデルがありません。prices.json をアップロードしてください。</p>;
  }

  return (
    <ul class="models">
      {groups.map((group) => (
        <ModelRow key={group.modelId} group={group} />
      ))}
    </ul>
  );
}

function ModelRow({ group }: { group: ModelGroup }) {
  return (
    <li class="model">
      <div class="model-head">
        <span class="model-id">{group.modelId}</span>
        <span class={group.enabled ? "badge" : "badge off"}>{group.enabled ? "一覧に出す" : "一覧に出さない"}</span>
      </div>
      {group.note === null ? null : <p class="note">{group.note}</p>}
      <ul class="prices">
        {group.prices.map((price) => (
          <li key={`${price.unit}:${price.variant}`}>
            <span class="price">{formatCost(price.costUsd, price.unit)}</span>
            {price.variant === "" ? null : <span class="variant">{price.variant}</span>}
          </li>
        ))}
      </ul>
    </li>
  );
}

function MasterUpload({ onUploaded }: { onUploaded: () => void }) {
  const [kind, setKind] = useState<MasterKind>("enabled");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const file = input.current?.files?.[0];

    if (file === undefined) {
      return;
    }

    setBusy(true);

    try {
      const result = await uploadMaster(kind, await file.text());

      if (!result.ok) {
        setNote({ text: result.message, error: true });
        return;
      }

      setNote({
        text: `反映しました（${kind}.json${result.version === null ? "" : ` / version ${result.version}`}）`,
        error: false,
      });

      if (input.current !== null) {
        input.current.value = "";
      }

      onUploaded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="upload">
      <h2>マスタの更新</h2>
      <p class="note">
        現在のファイルをダウンロードして編集し、アップロードすると再起動なしで反映されます。直前の内容は
        <code>.bak</code> に 1 世代残ります。反映した内容は元に戻せないため、先にダウンロードしておいてください。
      </p>
      <div class="upload-row">
        <label class="field">
          <span>種類</span>
          <select
            value={kind}
            onChange={(event) => setKind((event.currentTarget as HTMLSelectElement).value as MasterKind)}
          >
            {MASTER_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}.json
              </option>
            ))}
          </select>
        </label>
        <a class="link" href={masterDownloadUrl(kind)}>
          現在の {kind}.json をダウンロード
        </a>
      </div>
      <div class="upload-row">
        <input ref={input} type="file" accept="application/json,.json" disabled={busy} />
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? "反映中" : "アップロード"}
        </button>
      </div>
      {note === null ? null : <p class={note.error ? "note error" : "note ok"}>{note.text}</p>}
    </section>
  );
}
