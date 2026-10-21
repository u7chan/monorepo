import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type SecretsScope } from "../api";
import { useSpaceApi } from "../SpaceContext";
import { copyToClipboard } from "../lib/copyToClipboard";
import { cn } from "../lib/cn";
import { useAgentDrag } from "../hooks/useAgentDrag";
import { fileTimeLabel, messageFullTimeLabel } from "../lib/messageTime";
import {
  canSubmitEnvDraft,
  canSubmitEnvValue,
  ENV_KIND_LEGEND,
  ENV_PROJECT_NOTE,
  ENV_SAVE_LABEL,
  ENV_TRIM_NOTE,
  envKindLabel,
  envKindNotes,
  envNameList,
  envNamePreview,
  envValueActionLabel,
  envValueFormTitle,
  initialDraftValue,
  orderedEnvItems,
  sessionEnvScopeFromKey,
  sessionEnvScopeKey,
  secretDeleteConfirmRequest,
  type SessionEnvScope,
  shortSecretNote,
} from "../lib/sessionEnv";
import type { SecretItem, SecretKind, SecretsListResponse } from "../types";
import { CheckIcon, CopyIcon, EyeIcon, GripIcon, PlusIcon } from "./icons";
import { EnvValueBox } from "./EnvValueBox";
import { ReloadButton } from "./ReloadButton";
import { TabToolbar } from "./TabToolbar";
import { useConfirm } from "./ConfirmProvider";
import { RowMenu } from "./RowMenu";

export type EnvVarsTabProps = {
  /**
   * 要求元。会話 (sessionId) か、まだ会話が無いプロジェクト起点の新規会話 (projectId) のどちらか一方。
   * cwd はサーバーが解決するため client からは送らない。
   */
  scope: SecretsScope;
  /** 取り直しの合図 (作業フォルダタブの「再読み込み」と同じ token) */
  reloadToken: number;
};

/** 一覧のドラッグで使う名前。行の属性・追従の CSS 変数・ body クラスは styles/index.css と揃える */
const ENV_DRAG_NAMING = {
  rowAttribute: "data-env-row",
  yVariable: "--env-drag-y",
  bodyClass: "is-dragging-env",
};

/** 開いているフォーム。値は入力欄の中だけで持ち、どこにも永続化しない */
type FormState = { mode: "closed" } | { mode: "create" } | { mode: "edit"; item: SecretItem };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 値と失敗の記録から 1 件落とす (行が消えたときと、値を取り直せたとき) */
function withoutKey(record: Record<string, string>, secretId: string): Record<string, string> {
  const next = { ...record };
  delete next[secretId];
  return next;
}

/** 一覧に残っている行の記録だけを残す (消えた行の値を古い一覧と組み合わせて表示しない) */
function keepListed(record: Record<string, string>, listed: ReadonlySet<string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [secretId, text] of Object.entries(record)) {
    if (listed.has(secretId)) next[secretId] = text;
  }
  return next;
}

/**
 * 作業環境 → 環境変数タブ。単一リスト + 種別バッジで、追加フォームで種別を選ぶ (既定はシークレット)。
 * 一覧は名前・種別・更新時刻だけを返すため、値は変数の行だけ詳細 API から引いて state に持つ
 * (シークレットは API にも返す経路が無い)。設計は docs/secrets.md、文言は client/src/lib/sessionEnv.ts を正とする。
 */
export function EnvVarsTab({ scope, reloadToken }: EnvVarsTabProps) {
  const { createSecret, deleteSecret, getSecretDetail, getSecrets, reorderSecrets, updateSecret } = useSpaceApi();
  const confirm = useConfirm();
  const [list, setList] = useState<SecretsListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [manualReload, setManualReload] = useState(0);
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [kind, setKind] = useState<SecretKind>("secret");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 保存の注記と操作の失敗はフォームの外へ出す (フォームが畳まれた後も読めるようにする)
  const [feedback, setFeedback] = useState<{ kind: "notice" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 値は secretId -> 取得済みの文字列。未取得 (`…`) と取得失敗を区別するため、失敗は別に持つ
  const [values, setValues] = useState<Record<string, string>>({});
  const [valueErrors, setValueErrors] = useState<Record<string, string>>({});
  const [expandedValues, setExpandedValues] = useState<ReadonlySet<string>>(() => new Set());
  // 名前チップの copied と共有すると、同名のチップが同時にチェックへ変わる
  const [copiedValueId, setCopiedValueId] = useState<string | null>(null);
  // ドラッグ中の下書き順。null = 一覧の順 (取得のたびに捨てる)
  const [order, setOrder] = useState<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const containerRef = useRef<HTMLUListElement | null>(null);
  // 確定は再描画を待たずに最新の下書きを読む (最後の move の state 反映より pointerup が先でも取りこぼさない)
  const orderRef = useRef<string[] | null>(null);
  const applyOrder = (ids: string[] | null) => {
    orderRef.current = ids;
    setOrder(ids);
  };

  const reload = useCallback(() => setManualReload((count) => count + 1), []);

  /**
   * 変数行の値を引く。一覧の取得と並べ替えの応答 (別タブが同じ cwd へ追加した行) で同じ経路を使い、
   * 一覧に現れた変数行の値が「…」のまま残らないようにする。
   */
  const loadValues = useCallback(
    (target: SessionEnvScope, items: readonly SecretItem[], signal?: AbortSignal) => {
      for (const item of items) {
        if (item.kind !== "variable") continue;
        getSecretDetail(target, item.secretId, signal)
          .then((detail) => {
            if (signal?.aborted) return;
            setValues((current) => ({ ...current, [item.secretId]: detail.value ?? "" }));
            setValueErrors((current) => withoutKey(current, item.secretId));
          })
          .catch((error: unknown) => {
            if (signal?.aborted) return;
            // 他経路で消えた行なので、注記ではなく一覧を取り直す (一覧からも落ちる)
            if (error instanceof ApiError && error.status === 404) {
              reload();
              return;
            }
            setValueErrors((current) => ({ ...current, [item.secretId]: errorText(error) }));
          });
      }
    },
    [getSecretDetail, reload],
  );

  const scopeKey = sessionEnvScopeKey(scope);
  const token = reloadToken + manualReload;

  // 取得は scope と token の組でやり直す。古い要求の応答で新しい表示を上書きしない
  useEffect(() => {
    const controller = new AbortController();
    const target = sessionEnvScopeFromKey(scopeKey);
    setListError(null);
    getSecrets(target, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setList(next);
        // 並びは取得のたびにサーバーの順へ戻す (古い下書きで確定済みの並びを上書きしない)
        applyOrder(null);
        const variableIds = new Set(next.items.filter((item) => item.kind === "variable").map((item) => item.secretId));
        // 再取得中も前の値は残す (… へ戻してちらつかせない)。展開は取り直しのたびに畳む
        setValues((current) => keepListed(current, variableIds));
        setValueErrors((current) => keepListed(current, variableIds));
        setExpandedValues(new Set());
        loadValues(target, next.items, controller.signal);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setListError(errorText(error));
        applyOrder(null);
        // 古い一覧と古い値の組み合わせを残さない
        setValues({});
        setValueErrors({});
        setExpandedValues(new Set());
      });
    return () => controller.abort();
  }, [scopeKey, token, reload]);

  const closeForm = useCallback(() => {
    setForm({ mode: "closed" });
    setFeedback(null);
    setRevealed(false);
    setName("");
    setValue("");
  }, []);

  // desktop の右パネルは dialog ではないため、Escape で開いているフォームを畳む (決定事項 4 の破棄)。
  // singleColumn のシートは dialog の標準終了が先に走り、stopPropagation でここへは届かない
  const formOpen = form.mode !== "closed";
  useEffect(() => {
    if (!formOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      closeForm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [formOpen, closeForm]);

  /** 変更フォームを開く。変数は保持済みの値でプリフィルし、未取得の行だけ詳細を引く */
  const openEdit = async (item: SecretItem) => {
    setFeedback(null);
    setRevealed(false);
    setKind(item.kind);
    setValue("");
    setForm({ mode: "edit", item });
    if (item.kind !== "variable") return;
    if (values[item.secretId] !== undefined) {
      setValue(initialDraftValue(item, values));
      return;
    }
    // 保存済みの平文を返すのは変数の詳細だけ。シークレットは引かない
    setBusy(true);
    try {
      const detail = await getSecretDetail(scope, item.secretId);
      setValue(initialDraftValue(item, { [item.secretId]: detail.value ?? "" }));
    } catch (error) {
      setFeedback({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (form.mode === "closed" || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result =
        form.mode === "create"
          ? await createSecret({ ...scope, kind, name, value })
          : await updateSecret(scope, form.item.secretId, value);
      // 加工した事実は無言にしない (フォームを畳んだ後もこの 1 行を残す)
      setFeedback(result.trimmed ? { kind: "notice", text: ENV_TRIM_NOTE } : null);
      setRevealed(false);
      setForm({ mode: "closed" });
      setName("");
      setValue("");
      reload();
    } catch (error) {
      setFeedback({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: SecretItem) => {
    if (!(await confirm(secretDeleteConfirmRequest(item)))) return;
    setBusy(true);
    setFeedback(null);
    try {
      await deleteSecret(scope, item.secretId);
      if (form.mode === "edit" && form.item.secretId === item.secretId) closeForm();
      reload();
    } catch (error) {
      setFeedback({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const copyName = async (target: string) => {
    try {
      await copyToClipboard(target);
      setCopied(target);
      window.setTimeout(() => setCopied((current) => (current === target ? null : current)), 1500);
    } catch {
      // コピーできない環境では導線を出したままにする (名前を選択して手でコピーできる)
    }
  };

  const copyValue = async (secretId: string, text: string) => {
    try {
      await copyToClipboard(text);
      setCopiedValueId(secretId);
      window.setTimeout(() => setCopiedValueId((current) => (current === secretId ? null : current)), 1500);
    } catch {
      // コピーできない環境でも値は行に出ている (省略中は「すべて表示」で全文へ開ける)
    }
  };

  const toggleValue = (secretId: string) => {
    setExpandedValues((current) => {
      const next = new Set(current);
      if (next.has(secretId)) next.delete(secretId);
      else next.add(secretId);
      return next;
    });
  };

  const items = orderedEnvItems(list?.items ?? [], order);
  const shortNote = shortSecretNote(kind, value);
  const showForm = form.mode !== "closed";
  const editing = form.mode === "edit" ? form.item : null;
  // 変更フォームは名前を送らない (名前と種別は変えられない) ため、値だけで送信可否を決める
  const submittingDisabled = busy || (editing ? !canSubmitEnvValue(value) : !canSubmitEnvDraft({ name, value }));

  /**
   * ドラッグの確定。成功したら応答の並びを一覧へ書き戻す (値は secretId ごとに保持しているため
   * 取り直さない)。HTTP エラーは保存されていないので表示を元の順へ戻し、応答が返らない失敗は
   * 保存結果が不明なので下書きを残して次の取得でサーバーの順へ合わせる。
   */
  const commitOrder = async () => {
    const ids = orderRef.current;
    if (ids === null || savingOrder) return;
    setSavingOrder(true);
    setFeedback(null);
    try {
      const next = await reorderSecrets(scope, ids);
      setList(next);
      applyOrder(null);
      // 応答にだけ現れた行 (別タブが同じ cwd へ追加した行) も値を引く
      loadValues(sessionEnvScopeFromKey(scopeKey), next.items);
    } catch (error) {
      if (error instanceof ApiError) applyOrder(null);
      setFeedback({ kind: "error", text: errorText(error) });
    } finally {
      setSavingOrder(false);
    }
  };

  const drag = useAgentDrag({
    containerRef,
    naming: ENV_DRAG_NAMING,
    ids: items.map((item) => item.secretId),
    onMove: applyOrder,
    onCommit: () => void commitOrder(),
    onCancel: () => applyOrder(null),
    disabled: savingOrder,
  });

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-y-auto">
      <TabToolbar
        actions={
          <>
            {showForm ? null : (
              <button
                type="button"
                onClick={() => {
                  closeForm();
                  setKind("secret");
                  setForm({ mode: "create" });
                }}
                className="btn-quiet"
              >
                <PlusIcon />
                追加
              </button>
            )}
            <ReloadButton onClick={reload}>再読み込み</ReloadButton>
          </>
        }
      />

      <div className="grid gap-2 px-4 py-3">
        {list?.projectScoped ? <p className="text-2xs text-ink-faint">{ENV_PROJECT_NOTE}</p> : null}
        <dl className="grid gap-1 text-2xs leading-4">
          {ENV_KIND_LEGEND.map((entry) => (
            <div key={entry.kind} className="flex items-baseline gap-3">
              <dt
                className={cn(
                  "w-16 shrink-0 whitespace-nowrap",
                  entry.kind === "secret" ? "text-accent-text" : "text-ink-soft",
                )}
              >
                {envKindLabel(entry.kind)}
              </dt>
              <dd className="text-ink-faint">{entry.text}</dd>
            </div>
          ))}
        </dl>

        {listError ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-raised px-2.5 py-2 text-2xs text-danger-text"
          >
            {listError}
          </p>
        ) : null}
        {feedback ? (
          <p
            {...(feedback.kind === "error" ? { role: "alert" } : {})}
            className={feedback.kind === "error" ? "text-2xs text-danger-text" : "text-2xs text-ink-muted"}
          >
            {feedback.text}
          </p>
        ) : null}

        {showForm ? (
          <form
            autoComplete="off"
            className="grid gap-2 rounded-lg border border-line bg-raised px-3 py-3"
            onSubmit={(event) => {
              // Enter での送信も 1 か所 (submit) へ寄せる
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink-strong">
                {editing ? envValueFormTitle(editing) : "環境変数を追加"}
              </h3>
              <button type="button" onClick={closeForm} className="btn-quiet">
                閉じる
              </button>
            </div>

            <label className="grid gap-1 text-2xs text-ink-soft">
              種別
              <select
                value={kind}
                disabled={editing !== null}
                onChange={(event) => {
                  setKind(event.target.value === "variable" ? "variable" : "secret");
                  // 変数に切り替えたら伏せ状態を引き継がない (戻したときに見えていたら驚く)
                  setRevealed(false);
                }}
                className="field text-xs"
              >
                <option value="secret">シークレット</option>
                <option value="variable">変数</option>
              </select>
            </label>

            {editing ? null : (
              <label className="grid gap-1 text-2xs text-ink-soft">
                名前
                <input
                  type="text"
                  value={name}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                  className="field font-mono text-xs"
                  placeholder="DATABASE_URL"
                />
                {/* 正規化後の名前を入力中に出す (保存・注入・表示はこの名前で揃う) */}
                <span className="text-2xs text-ink-faint">
                  保存される名前: <code className="font-mono">{envNamePreview(name) || "（未入力）"}</code>
                </span>
              </label>
            )}

            <label className="grid gap-1 text-2xs text-ink-soft">
              値
              <span className="flex items-center gap-2">
                <input
                  // 種別を変えたら input ごと作り直す。type だけを差し替えると、シークレットで
                  // パスワード欄として認識された入力が変数のままパスワード保存の対象に残る
                  key={kind}
                  // シークレットは既定で伏せ、Eye は入力欄にだけ効く (保存済みの値は表示しない)
                  type={kind === "secret" && !revealed ? "password" : "text"}
                  value={value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setValue(event.target.value)}
                  className="field font-mono text-xs"
                />
                {/* 変数は伏せないので Eye を出さない (押しても何も変わらない導線を置かない) */}
                {kind === "secret" ? (
                  <button
                    type="button"
                    onClick={() => setRevealed((current) => !current)}
                    aria-pressed={revealed}
                    aria-label={revealed ? "値を隠す" : "値を表示"}
                    title={revealed ? "値を隠す" : "値を表示"}
                    className="icon-button"
                  >
                    <EyeIcon open={revealed} />
                  </button>
                ) : null}
              </span>
            </label>

            <ul className="grid gap-0.5 text-2xs text-ink-muted">
              {envKindNotes(kind).map((note) => (
                <li key={note}>{note}</li>
              ))}
              {shortNote ? <li className="text-warn">{shortNote}</li> : null}
            </ul>

            <div className="flex items-center gap-2">
              <button type="submit" disabled={submittingDisabled} className="btn-primary">
                {editing ? ENV_SAVE_LABEL : "追加する"}
              </button>
            </div>
          </form>
        ) : null}

        {items.length > 0 ? (
          <ul
            ref={containerRef}
            className="divide-y divide-line rounded-lg border border-line"
            {...drag.containerHandlers}
          >
            {items.map((item) => (
              <li
                key={item.secretId}
                data-env-row={item.secretId}
                className={cn(
                  "flex min-w-0 items-start gap-1 pr-2 pl-1 first:rounded-t-lg last:rounded-b-lg",
                  drag.draggingId === item.secretId && "env-drag-row bg-panel",
                )}
              >
                {/* グリップは行の外側 (名前の前)。行そのものはドラッグしない (行の操作と衝突させない)。
                  行の高さは値で変わるため、グリップは名前の行 (先頭) へ合わせる */}
                <button
                  type="button"
                  aria-label={`${item.name} の順番を変更`}
                  title="ドラッグで並べ替え"
                  className="drag-grip mt-2 h-6 self-start singleColumn:h-11"
                  {...drag.gripHandlers(item.secretId)}
                >
                  <GripIcon />
                </button>
                <div className="grid min-w-0 flex-1 gap-1 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-strong" title={item.name}>
                      {item.name}
                    </code>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-2xs",
                        item.kind === "secret" ? "border-accent/50 text-accent-text" : "border-line text-ink-soft",
                      )}
                    >
                      {envKindLabel(item.kind)}
                    </span>
                    <time
                      dateTime={new Date(item.updatedAt).toISOString()}
                      title={messageFullTimeLabel(item.updatedAt)}
                      className="shrink-0 text-2xs whitespace-nowrap text-ink-ghost tabular-nums"
                    >
                      {fileTimeLabel(item.updatedAt)}
                    </time>
                    <RowMenu
                      name={item.name}
                      actions={[
                        { kind: "rename", label: envValueActionLabel(item.kind) },
                        { kind: "delete", label: "削除", danger: true },
                      ]}
                      onSelect={(action) => {
                        if (action === "rename") void openEdit(item);
                        else void remove(item);
                      }}
                    />
                  </div>
                  {/* 値は変数だけ。シークレットは API が値を返さないため行の高さも今のままにする */}
                  {item.kind === "variable" ? (
                    <EnvValueBox
                      value={values[item.secretId]}
                      failure={valueErrors[item.secretId]}
                      expanded={expandedValues.has(item.secretId)}
                      copied={copiedValueId === item.secretId}
                      onToggle={() => toggleValue(item.secretId)}
                      onCopy={(text) => void copyValue(item.secretId, text)}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {list !== null && items.length === 0 ? (
          <p className="text-2xs text-ink-faint">
            この作業フォルダにはまだ環境変数がありません。シークレットを登録すると、サービスとして起動したときだけ
            <code className="font-mono"> process.env</code> から読めます。
          </p>
        ) : null}

        {/* エージェントへ渡してよいのは名前だけ。値を渡す導線は作らない */}
        {items.length > 0 ? (
          <section className="grid gap-1 border-t border-line pt-2">
            <h3 className="text-2xs font-semibold text-ink-soft">この会話で使える名前</h3>
            <p className="text-2xs text-ink-faint">
              コードは <code className="font-mono">process.env.NAME</code> を読んでください。
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {envNameList(items).map((entry) => (
                <li key={entry}>
                  <button
                    type="button"
                    onClick={() => void copyName(entry)}
                    className="btn-quiet font-mono text-2xs"
                    title={`${entry} をコピー`}
                  >
                    {copied === entry ? <CheckIcon /> : <CopyIcon />}
                    {entry}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
