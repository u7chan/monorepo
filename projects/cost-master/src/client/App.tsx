import { useEffect, useState } from "preact/hooks";
import type { CostMasterPayload } from "../shared/contract";
import { formatCost, formatFetchedAt } from "../shared/format";
import { fetchModels } from "./api";
import { groupByModel, summarize, type ModelGroup } from "./models";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; payload: CostMasterPayload };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetchModels(controller.signal)
      .then((payload) => setState({ status: "ok", payload }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({ status: "error", message: error instanceof Error ? error.message : "マスタを取得できませんでした" });
      });

    return () => controller.abort();
  }, []);

  return (
    <main class="page">
      <header class="head">
        <h1>Cost Master</h1>
        <p class="lead">
          コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断。読み取り専用で、判断は enabled.json
          をローカルで編集してデプロイする。
        </p>
        {state.status === "ok" ? <Summary payload={state.payload} /> : null}
      </header>

      {state.status === "loading" ? <p class="note">読み込み中…</p> : null}
      {state.status === "error" ? <p class="note error">{state.message}</p> : null}
      {state.status === "ok" ? <ModelList payload={state.payload} /> : null}
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
    return <p class="note">価格が宣言されているモデルがありません。bun run generate で取り込む。</p>;
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
