import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { COST_UNITS, MASTER_KINDS, type CostMasterPayload, type MasterKind } from "../shared/contract";
import { formatCost, formatFetchedAt } from "../shared/format";
import { fetchModels, masterDownloadUrl, updateJudgment, uploadMaster } from "./api";
import { KindIcon, type KindIconName } from "./icons";
import {
  countByKind,
  filterByKind,
  groupByModel,
  priceKey,
  sideOf,
  sortGroups,
  splitModelId,
  summarize,
  withModelEnabled,
  type KindFilter,
  type ModelGroup,
  type ModelSort,
} from "./models";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; payload: CostMasterPayload };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [kind, setKind] = useState<KindFilter>("all");
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
          コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断。スイッチで切り替えると再起動なしで反映される。
          u7agent の一覧は [カタログ更新] を押すまで変わらない。
        </p>
        {state.status === "ok" ? <Summary payload={state.payload} kind={kind} /> : null}
      </header>

      {state.status === "loading" ? (
        <p class="notice" role="status">
          読み込み中…
        </p>
      ) : null}
      {state.status === "error" ? (
        <p class="notice error" role="alert">
          {state.message}
        </p>
      ) : null}
      {toggleError === null ? null : (
        <p class="notice error" role="alert">
          {toggleError}
        </p>
      )}
      {state.status === "ok" ? (
        <ModelList payload={state.payload} kind={kind} onKindChange={setKind} pending={pending} onToggle={toggle} />
      ) : null}

      <MasterUpload onUploaded={reload} />
    </main>
  );
}

const KIND_LABEL: Record<KindFilter, string> = { all: "全体", image: "画像", speech: "音声" };

function Summary({ payload, kind }: { payload: CostMasterPayload; kind: KindFilter }) {
  // 一覧を絞ったら統計も同じ範囲を数える。全体と表示中の数が混ざると「一覧に出さない」の意味が読めない
  const summary = summarize(filterByKind(payload.models, kind));

  return (
    <div class="stats-wrap">
      <dl class="stats">
        <Stat label="モデル" value={summary.models} />
        <Stat label="価格行" value={summary.rows} />
        <Stat label="一覧に出さない" value={summary.hidden} />
        <Stat label="世代" value={`v${payload.version}`} />
        <Stat label="価格の取得" value={formatFetchedAt(payload.fetchedAt)} small />
      </dl>
      {kind === "all" ? null : (
        <p class="caption">統計は{KIND_LABEL[kind]}だけを数えています（世代と取得日時は全体）。</p>
      )}
    </div>
  );
}

function Stat({ label, value, small = false }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div class="stat">
      <dt>{label}</dt>
      <dd class={small ? "stat-small" : undefined}>{value}</dd>
    </div>
  );
}

type SegmentOption<T extends string> = { value: T; label: string; icon?: KindIconName; count?: number };

function Segmented<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      class="segmented"
      role="radiogroup"
      aria-label={label}
      style={{ "--cm-seg-count": options.length, "--cm-seg-index": index }}
    >
      <span class="segmented-thumb" aria-hidden="true" />
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon === undefined ? null : (
            <span class="seg-icon">
              <KindIcon name={option.icon} />
            </span>
          )}
          {option.label}
          {option.count === undefined ? null : <span class="seg-count">{option.count}</span>}
        </label>
      ))}
    </div>
  );
}

const SORT_OPTIONS = [
  { value: "name", label: "名前順" },
  { value: "cost", label: "単価の安い順" },
] as const satisfies readonly { value: ModelSort; label: string }[];

const KIND_OPTIONS = MASTER_KINDS.map((kind) => ({ value: kind, label: `${kind}.json` }));

function categoryOptions(counts: Record<KindFilter, number>) {
  return [
    { value: "all", label: "すべて", icon: "all", count: counts.all },
    { value: "image", label: "画像", icon: "image", count: counts.image },
    { value: "speech", label: "音声", icon: "speech", count: counts.speech },
  ] as const satisfies readonly SegmentOption<KindFilter>[];
}

function unitsOf(groups: readonly ModelGroup[]): readonly string[] {
  const present = new Set(groups.flatMap((group) => group.prices.map((price) => price.unit)));

  return COST_UNITS.filter((unit) => present.has(unit));
}

function costCaption(kind: KindFilter, units: readonly string[]): string {
  if (kind === "all") {
    return "カテゴリ（画像 → 音声）→ 単価の単位 → 単価の安い順に並べています。単位が違うモデルは数値で比べられません。";
  }

  return `単価の単位が違うモデルは比べられないため、${units.join(" → ")} の順にまとめ、その中で安い順に並べています。`;
}

function ModelList({
  payload,
  kind,
  onKindChange,
  pending,
  onToggle,
}: {
  payload: CostMasterPayload;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  pending: string | null;
  onToggle: (modelId: string, enabled: boolean) => void;
}) {
  const [sort, setSort] = useState<ModelSort>("name");
  const allGroups = groupByModel(payload.models);
  const groups = sortGroups(filterByKind(allGroups, kind), sort);

  if (allGroups.length === 0) {
    return <p class="notice">価格が宣言されているモデルがありません。prices.json をアップロードしてください。</p>;
  }

  return (
    <section aria-labelledby="models-title">
      <div class="toolbar">
        <div class="toolbar-start">
          <h2 id="models-title" class="section-title">
            モデル
          </h2>
          <Segmented
            name="category"
            label="モデルの種類"
            options={categoryOptions(countByKind(allGroups))}
            value={kind}
            onChange={onKindChange}
          />
        </div>
        <Segmented name="sort" label="並び順" options={SORT_OPTIONS} value={sort} onChange={setSort} />
      </div>
      {kind === "speech" ? (
        <p class="caption">
          音声モデルの多くは入力（文字数・バイト・トークン）の単価だけを返します。出力（音声トークン・分）の行があるときは、入力の行に「入力」タグが付きます。
        </p>
      ) : null}
      {sort === "cost" ? <p class="caption">{costCaption(kind, unitsOf(groups))}</p> : null}
      {groups.length === 0 ? (
        <p class="notice">{KIND_LABEL[kind]}のモデルがありません。</p>
      ) : (
        <ul class="group">
          {groups.map((group) => (
            <ModelRow
              key={group.modelId}
              group={group}
              showIcon={kind === "all"}
              busy={pending === group.modelId}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ModelRow({
  group,
  showIcon,
  busy,
  onToggle,
}: {
  group: ModelGroup;
  showIcon: boolean;
  busy: boolean;
  onToggle: (modelId: string, enabled: boolean) => void;
}) {
  const { provider, name } = splitModelId(group.modelId);

  return (
    <li class={`model${group.enabled ? "" : " is-off"}${showIcon ? " has-icon" : ""}`}>
      {showIcon ? (
        <span class="model-icon">
          <KindIcon name={group.kind} />
        </span>
      ) : null}
      <div class="model-name">
        {provider === "" ? null : <span class="model-provider">{provider}/</span>}
        <span class="model-title">{name}</span>
        {group.note === null ? null : <p class="model-note">{group.note}</p>}
      </div>
      <label class="toggle">
        <span class={group.enabled ? "toggle-state" : "toggle-state off"}>
          {group.enabled ? "一覧に出す" : "一覧に出さない"}
        </span>
        <input
          class="switch"
          type="checkbox"
          role="switch"
          checked={group.enabled}
          disabled={busy}
          aria-label={`${group.modelId} を一覧に出す`}
          onChange={(event) => onToggle(group.modelId, (event.currentTarget as HTMLInputElement).checked)}
        />
      </label>
      <ul class="prices">
        {group.prices.map((price) => (
          <li key={priceKey(price)} class="price-tile">
            {sideOf(price) === "input" ? <span class="tag">入力</span> : null}
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
    <section class="upload" aria-labelledby="upload-title">
      <h2 id="upload-title" class="section-title">
        マスタの更新
      </h2>
      <div class="group">
        <div class="form-row">
          <span class="form-label">種類</span>
          <Segmented name="kind" label="種類" options={KIND_OPTIONS} value={kind} onChange={setKind} />
          <a class="button secondary" href={masterDownloadUrl(kind)}>
            現在の {kind}.json をダウンロード
          </a>
        </div>
        <div class="form-row">
          <input
            ref={input}
            class="file"
            type="file"
            accept="application/json,.json"
            aria-label={`アップロードする ${kind}.json`}
            disabled={busy}
          />
          <button class="button primary" type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "反映中" : "アップロード"}
          </button>
        </div>
      </div>
      <p class="caption">
        一括で変えるときや、判断を戻すときに使います。アップロードすると再起動なしで反映され、直前のファイルは
        <code>.bak</code> に 1 世代だけ残ります。スイッチの操作もこの <code>.bak</code> を上書きするため、
        戻す用のファイルは先にダウンロードしておいてください。
      </p>
      {note === null ? null : (
        <p class={note.error ? "notice error" : "notice ok"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </section>
  );
}
