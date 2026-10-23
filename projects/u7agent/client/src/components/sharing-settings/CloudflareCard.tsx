import { useEffect, useRef, useState } from "react";
import { cloudflareDeleteConfirmRequest, cloudflareDraftDirty, cloudflareSaveBody } from "../../lib/cloudflareSettings";
import type { CloudflareSettingsResponse, UpdateCloudflareSettingsBody } from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { ExternalLinkIcon, TrashIcon } from "../icons";

export type CloudflareCardProps = {
  settings: CloudflareSettingsResponse;
  /** 進行中の変更。保存 / 削除のどちらかを表示へ返す */
  saving: "save" | "delete" | null;
  onSave: (input: UpdateCloudflareSettingsBody) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
};

/**
 * Cloudflare の接続カード。トークンは write-only なので、登録済みでも入力欄は空から始める。
 * アカウント ID を変えない更新ではトークンを省略でき、保存済みの暗号文を維持する。
 */
export function CloudflareCard({ settings, saving, onSave, onDelete }: CloudflareCardProps) {
  const confirm = useConfirm();
  const [accountId, setAccountId] = useState(settings.accountId ?? "");
  const [apiToken, setApiToken] = useState("");
  // 保存値のアカウント ID が変わったときだけ、下書きを保存値へ合わせる (入力中の値は巻き戻さない)
  const appliedAccount = useRef(settings.accountId);
  useEffect(() => {
    if (appliedAccount.current === settings.accountId) return;
    appliedAccount.current = settings.accountId;
    setAccountId(settings.accountId ?? "");
    setApiToken("");
  }, [settings.accountId]);

  const draft = { accountId, apiToken };
  const dirty = cloudflareDraftDirty(draft, settings);
  const canSave =
    settings.available &&
    dirty &&
    accountId.trim() !== "" &&
    (settings.configured || apiToken.trim() !== "") &&
    saving === null;

  const submit = async () => {
    if (!canSave) return;
    // 成功したときだけ入力を消す。失敗したトークンを画面に残さないよう、保存値は応答から作り直す
    if (await onSave(cloudflareSaveBody(draft))) setApiToken("");
  };

  const remove = async () => {
    if (saving !== null) return;
    if (!(await confirm(cloudflareDeleteConfirmRequest()))) return;
    await onDelete();
  };

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">CLOUDFLARE</h3>
        <span className="text-2xs text-ink-muted">{settings.configured ? "登録済み" : "未登録"}</span>
      </div>

      {settings.available ? null : (
        <p role="alert" className="text-2xs leading-relaxed text-warn">
          {settings.unavailableReason ?? "暗号化の master key が使えないため、資格情報を登録できません。"}
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
          <span className="text-2xs text-ink-faint">アカウント ID</span>
          <input
            className="field text-xs"
            type="text"
            value={accountId}
            placeholder="32 桁の 16 進数"
            aria-label="Cloudflare のアカウント ID"
            autoComplete="off"
            spellCheck={false}
            disabled={!settings.available}
            onChange={(event) => setAccountId(event.currentTarget.value)}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-2xs text-ink-faint">API トークン</span>
          <input
            className="field text-xs"
            type="password"
            value={apiToken}
            placeholder={settings.configured ? "保存済み（変更するときだけ入力）" : "Cloudflare の API トークン"}
            aria-label="Cloudflare の API トークン"
            autoComplete="off"
            spellCheck={false}
            disabled={!settings.available}
            onChange={(event) => setApiToken(event.currentTarget.value)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={!canSave}>
            {saving === "save" ? "保存中" : "保存"}
          </button>
          {settings.configured ? (
            <button type="button" className="btn-quiet" disabled={saving !== null} onClick={() => void remove()}>
              <TrashIcon />
              {saving === "delete" ? "削除中" : "削除"}
            </button>
          ) : null}
        </div>
      </form>

      <div className="grid gap-1 text-2xs leading-relaxed text-ink-ghost">
        <p>保存済みの API トークンは再表示しません。変更するときは新しいトークンを入れ直してください。</p>
        <p>
          トークンには Workers の Admin（product scope）が必要です。zone の権限は不要です。
          <a
            className="ml-1 inline-flex items-center gap-1 text-ink-muted underline underline-offset-2 hover:text-ink"
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
          >
            API トークンを作成
            <ExternalLinkIcon />
          </a>
        </p>
      </div>
    </section>
  );
}
