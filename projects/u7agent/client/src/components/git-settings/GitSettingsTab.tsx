import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  GIT_IDENTITY_CLEAR_CONFIRM,
  GIT_IDENTITY_SET_BADGE,
  GIT_IDENTITY_UNSET_BADGE,
  GIT_IDENTITY_UNSET_NOTE,
  gitIdentityCanSave,
  gitIdentityInputProblem,
} from "../../lib/gitSettings";
import type { GitSettingsResponse } from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { TrashIcon } from "../icons";

export type GitSettingsTabProps = {
  settings: GitSettingsResponse;
  saving: "save" | "clear" | null;
  onSave: (userName: string, userEmail: string) => Promise<boolean>;
  onClear: () => Promise<boolean>;
};

/**
 * 設定 → Git の本体。保存値は下書きの初期値にだけ使い、保存中に別タブが変えた値で入力を巻き戻さない
 * (反映は次の bash なので、編集中の値とサンドボックスの状態は一致しなくてよい)。
 */
export function GitSettingsTab({ settings, saving, onSave, onClear }: GitSettingsTabProps) {
  const confirm = useConfirm();
  const [userName, setUserName] = useState(settings.userName ?? "");
  const [userEmail, setUserEmail] = useState(settings.userEmail ?? "");
  const applied = useRef(`${settings.userName ?? ""}\u0000${settings.userEmail ?? ""}`);
  useEffect(() => {
    const key = `${settings.userName ?? ""}\u0000${settings.userEmail ?? ""}`;
    if (applied.current === key) return;
    applied.current = key;
    setUserName(settings.userName ?? "");
    setUserEmail(settings.userEmail ?? "");
  }, [settings.userName, settings.userEmail]);

  const problem = gitIdentityInputProblem(userName, userEmail);
  const canSave = gitIdentityCanSave({ userName, userEmail }, settings, saving !== null);

  const submit = async () => {
    if (!canSave) return;
    await onSave(userName, userEmail);
  };

  const clear = async () => {
    if (saving !== null || !settings.configured) return;
    if (!(await confirm(GIT_IDENTITY_CLEAR_CONFIRM))) return;
    await onClear();
  };

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <section className="grid gap-3 rounded-lg border border-line bg-soft p-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">GIT IDENTITY</h3>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-2xs",
                settings.configured ? "border-line text-ink-muted" : "border-warn/60 text-warn-text",
              )}
            >
              {settings.configured ? GIT_IDENTITY_SET_BADGE : GIT_IDENTITY_UNSET_BADGE}
            </span>
          </div>

          {settings.configured ? null : (
            <p role="status" className="text-2xs leading-relaxed text-warn-text">
              {GIT_IDENTITY_UNSET_NOTE}
            </p>
          )}

          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="grid gap-1">
              <span className="text-2xs text-ink-faint">名前（user.name）</span>
              <input
                className="field text-xs"
                type="text"
                value={userName}
                placeholder="例: u7chan"
                autoComplete="name"
                spellCheck={false}
                disabled={saving !== null}
                onChange={(event) => setUserName(event.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-2xs text-ink-faint">メールアドレス（user.email）</span>
              <input
                className="field text-xs"
                type="email"
                value={userEmail}
                placeholder="例: u7chan@example.com"
                autoComplete="email"
                spellCheck={false}
                disabled={saving !== null}
                onChange={(event) => setUserEmail(event.target.value)}
              />
            </label>

            {/* 片方だけ入っている状態を送らせない。押せない理由はボタンの近くに出して探させない */}
            {problem && (userName !== "" || userEmail !== "") ? (
              <p role="alert" className="text-2xs text-danger-text">
                {problem}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="btn-primary text-xs" disabled={!canSave}>
                保存
              </button>
              <button
                type="button"
                className="btn-quiet text-xs"
                disabled={saving !== null || !settings.configured}
                onClick={() => void clear()}
              >
                <TrashIcon />
                未設定に戻す
              </button>
            </div>
          </form>

          <p className="border-t border-line pt-2 text-2xs leading-relaxed text-ink-muted">
            この値はサンドボックスの global config にだけ書きます。ホストの
            <code className="font-mono"> ~/.gitconfig</code> は変更しません。repo local の設定は local が優先されます。
          </p>
        </section>
      </div>
    </div>
  );
}
