import { useCallback, useEffect, useState } from "react";
import { createSecret, deleteSecret, getSecretDetail, getSecrets, updateSecret, type SecretsScope } from "../api";
import { copyToClipboard } from "../lib/copyToClipboard";
import { cn } from "../lib/cn";
import { fileTimeLabel, messageFullTimeLabel } from "../lib/messageTime";
import {
  canSubmitEnvDraft,
  canSubmitEnvValue,
  ENV_PROJECT_NOTE,
  ENV_RESTART_NOTE,
  ENV_TRIM_NOTE,
  envKindLabel,
  envKindNotes,
  envNameList,
  envNamePreview,
  initialDraftValue,
  sessionEnvScopeFromKey,
  sessionEnvScopeKey,
  secretDeleteConfirmRequest,
  shortSecretNote,
} from "../lib/sessionEnv";
import type { SecretItem, SecretKind, SecretsListResponse } from "../types";
import { CheckIcon, CopyIcon, EyeIcon, PlusIcon, RefreshIcon } from "./icons";
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

/** 開いているフォーム。値は入力欄の中だけで持ち、どこにも永続化しない */
type FormState = { mode: "closed" } | { mode: "create" } | { mode: "edit"; item: SecretItem };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 作業環境 → 環境変数タブ。単一リスト + 種別バッジで、追加フォームで種別を選ぶ (既定はシークレット)。
 * 値は一覧に返らず (シークレットは API にも返す経路が無い)、変更フォームの入力欄だけが一度に 1 つ持つ。
 * 設計は docs/secrets.md、文言は client/src/lib/sessionEnv.ts を正とする。
 */
export function EnvVarsTab({ scope, reloadToken }: EnvVarsTabProps) {
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

  const scopeKey = sessionEnvScopeKey(scope);
  const token = reloadToken + manualReload;

  // 取得は scope と token の組でやり直す。古い要求の応答で新しい表示を上書きしない
  useEffect(() => {
    const controller = new AbortController();
    setListError(null);
    getSecrets(sessionEnvScopeFromKey(scopeKey), controller.signal)
      .then((next) => setList(next))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setListError(errorText(error));
      });
    return () => controller.abort();
  }, [scopeKey, token]);

  const closeForm = useCallback(() => {
    setForm({ mode: "closed" });
    setFeedback(null);
    setRevealed(false);
    setName("");
    setValue("");
  }, []);

  // desktop の右パネルは dialog ではないため、Escape で開いているフォームを畳む (決定事項 4 の破棄)。
  // compact のシートは dialog の標準終了が先に走り、stopPropagation でここへは届かない
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

  const reload = useCallback(() => setManualReload((count) => count + 1), []);

  /** 変更フォームを開く。変数は保存済みの値をプリフィルし、シークレットは空欄から始める */
  const openEdit = async (item: SecretItem) => {
    setFeedback(null);
    setRevealed(false);
    setKind(item.kind);
    setValue("");
    setForm({ mode: "edit", item });
    if (item.kind !== "variable") return;
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

  const items = list?.items ?? [];
  const shortNote = shortSecretNote(kind, value);
  const showForm = form.mode !== "closed";
  const editing = form.mode === "edit" ? form.item : null;
  // 変更フォームは名前を送らない (名前と種別は変えられない) ため、値だけで送信可否を決める
  const submittingDisabled = busy || (editing ? !canSubmitEnvValue(value) : !canSubmitEnvDraft({ name, value }));

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-y-auto">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line px-4 py-2">
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
        <button type="button" onClick={reload} className="btn-quiet">
          <RefreshIcon />
          再読み込み
        </button>
      </div>

      <div className="grid gap-2 px-4 py-3">
        {list?.projectScoped ? <p className="text-2xs text-ink-faint">{ENV_PROJECT_NOTE}</p> : null}
        <p className="text-2xs text-ink-muted">{ENV_RESTART_NOTE}</p>

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
            className="grid gap-2 rounded-lg border border-line bg-raised px-3 py-3"
            onSubmit={(event) => {
              // Enter での送信も 1 か所 (submit) へ寄せる
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink-strong">
                {editing ? `${editing.name} の値を変更` : "環境変数を追加"}
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
                onChange={(event) => setKind(event.target.value === "variable" ? "variable" : "secret")}
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
                  // シークレットは既定で伏せ、Eye は入力欄にだけ効く (保存済みの値は表示しない)
                  type={kind === "secret" && !revealed ? "password" : "text"}
                  value={value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setValue(event.target.value)}
                  className="field font-mono text-xs"
                />
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
                {editing ? "値を保存" : "追加する"}
              </button>
            </div>
          </form>
        ) : null}

        <ul className="grid gap-1">
          {items.map((item) => (
            <li key={item.secretId} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
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
                  { kind: "rename", label: "値を変更" },
                  { kind: "delete", label: "削除", danger: true },
                ]}
                onSelect={(action) => {
                  if (action === "rename") void openEdit(item);
                  else void remove(item);
                }}
              />
            </li>
          ))}
        </ul>

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
              コードは <code className="font-mono">process.env.NAME</code> を読んでください。値は渡せません。
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
