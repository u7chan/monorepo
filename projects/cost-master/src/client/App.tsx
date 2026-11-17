import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MASTER_KINDS, type CostMasterPayload, type MasterKind } from "../shared/contract";
import { formatCost, formatFetchedAt } from "../shared/format";
import { fetchModels, masterDownloadUrl, updateJudgment, uploadMaster } from "./api";
import { groupByModel, summarize, withModelEnabled, type ModelGroup } from "./models";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; payload: CostMasterPayload };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const reload = useCallback(() => {
    // アップロードで直した直後に、前回のトグル失敗の案内を残さない
    setToggleError(null);
    setNonce((value) => value + 1);
  }, []);

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

  // 一覧を読み込み中へ戻すと選択位置も失うので、成功時は取得し直さず確定した値だけを差し替える
  const toggle = useCallback(async (modelId: string, enabled: boolean) => {
    setPending(modelId);
    setToggleError(null);

    try {
      const result = await updateJudgment(modelId, enabled);

      if (!result.ok) {
        setToggleError(result.message);
        return;
      }

      setState((current) =>
        current.status === "ok"
          ? { status: "ok", payload: withModelEnabled(current.payload, modelId, enabled) }
          : current,
      );
    } finally {
      setPending(null);
    }
  }, []);

  return (
    <main class="page">
      <header class="head">
        <h1>Cost Master</h1>
        <p class="lead">
          コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断。チェックボックスで切り替えると
          再起動なしで反映される。u7agent の一覧は [カタログ更新] を押すまで変わらない。
        </p>
        {state.status === "ok" ? <Summary payload={state.payload} /> : null}
      </header>

      {state.status === "loading" ? <p class="note">読み込み中…</p> : null}
      {state.status === "error" ? <p class="note error">{state.message}</p> : null}
      {toggleError === null ? null : <p class="note error">{toggleError}</p>}
      {state.status === "ok" ? <ModelList payload={state.payload} pending={pending} onToggle={toggle} /> : null}

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

function ModelList({
  payload,
  pending,
  onToggle,
}: {
  payload: CostMasterPayload;
  pending: string | null;
  onToggle: (modelId: string, enabled: boolean) => void;
}) {
  const groups = groupByModel(payload.models);

  if (groups.length === 0) {
    return <p class="note">価格が宣言されているモデルがありません。prices.json をアップロードしてください。</p>;
  }

  return (
    <ul class="models">
      {groups.map((group) => (
        <ModelRow key={group.modelId} group={group} busy={pending === group.modelId} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function ModelRow({
  group,
  busy,
  onToggle,
}: {
  group: ModelGroup;
  busy: boolean;
  onToggle: (modelId: string, enabled: boolean) => void;
}) {
  return (
    <li class="model">
      <div class="model-head">
        <span class="model-id">{group.modelId}</span>
        <label class="toggle">
          <input
            type="checkbox"
            checked={group.enabled}
            disabled={busy}
            aria-label={`${group.modelId} を一覧に出す`}
            onChange={(event) => onToggle(group.modelId, (event.currentTarget as HTMLInputElement).checked)}
          />
          <span class={group.enabled ? "badge" : "badge off"}>{group.enabled ? "一覧に出す" : "一覧に出さない"}</span>
        </label>
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
        一括で変えるときや、判断を戻すときに使います。アップロードすると再起動なしで反映され、直前のファイルは
        <code>.bak</code> に 1 世代だけ残ります。チェックボックスの操作もこの <code>.bak</code> を上書きするため、
        戻す用のファイルは先にダウンロードしておいてください。
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
