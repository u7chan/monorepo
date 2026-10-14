import { useState } from "react";
import { oauthPanelView } from "../../lib/modelSettings";
import type { ProviderAuthSetting } from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";

export type OAuthSignInSectionProps = {
  provider: ProviderAuthSetting;
  runtimeAvailable: boolean;
  /** この provider の変更が進行中 (キーの保存などと同じフラグ) */
  busy: boolean;
  onLogin: (provider: string) => Promise<boolean>;
  onSubmitCode: (provider: string, code: string) => Promise<boolean>;
  onCancel: (provider: string) => Promise<boolean>;
  onSignOut: (provider: string) => Promise<boolean>;
};

/**
 * provider 詳細の OAuth サインイン。進行中の認可 URL・貼り付け欄・中断を出し、終端したら結果を残す
 * (消すのは [閉じる])。表示条件とボタン名は `oauthPanelView()` が決める。
 */
export function OAuthSignInSection({
  provider,
  runtimeAvailable,
  busy,
  onLogin,
  onSubmitCode,
  onCancel,
  onSignOut,
}: OAuthSignInSectionProps) {
  // 貼り付けは provider ごとの一時入力。provider を切り替えると親がこの要素を作り直す (key=provider)
  const [code, setCode] = useState("");
  const view = oauthPanelView(provider);
  if (!view.visible) return null;
  const login = view.login;
  const running = login?.status === "running";
  const disabled = !runtimeAvailable || busy;

  const submitCode = async () => {
    // 送れたときだけ入力を消す (失敗したら貼り付け直せるように残す)
    if (await onSubmitCode(provider.provider, code)) setCode("");
  };

  return (
    <section className="grid gap-1.5">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">OAuth サインイン</div>
      {!view.canSignIn ? (
        <p className="text-2xs leading-relaxed text-ink-muted">{view.unsupportedNotice}</p>
      ) : running && login ? (
        <div className="grid gap-1.5 rounded-md border border-line bg-soft px-2.5 py-2">
          <p className="text-2xs leading-relaxed text-ink">
            {login.progress ?? (login.authUrl ? login.instructions : "認可の準備をしています。")}
          </p>
          {login.authUrl ? (
            <a href={login.authUrl} target="_blank" rel="noreferrer noopener" className="text-2xs text-accent-text">
              承認ページを開く
            </a>
          ) : null}
          {login.userCode ? (
            <p className="text-2xs leading-relaxed text-ink">
              コード: <code className="text-ink-strong">{login.userCode}</code>
            </p>
          ) : null}
          {login.input ? (
            <form
              className="grid gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode();
              }}
            >
              <label className="grid gap-1 text-2xs text-ink-soft">
                {login.input.message}
                <input
                  className="field min-w-0 text-xs"
                  value={code}
                  placeholder={login.input.placeholder}
                  aria-label={`${provider.name} のサインインコード`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setCode(event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="submit" className="btn-primary" disabled={disabled || code.trim().length === 0}>
                  貼り付けた URL を送信
                </button>
              </div>
            </form>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => void onCancel(provider.provider)}
            >
              中断
            </button>
          </div>
        </div>
      ) : login ? (
        <div className="grid gap-1.5">
          <p
            role={login.status === "failed" ? "alert" : undefined}
            className={
              login.status === "failed"
                ? "rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs leading-relaxed text-warn"
                : "text-2xs leading-relaxed text-ink-muted"
            }
          >
            {login.status === "succeeded"
              ? "サインインしました。資格情報は Pi の auth.json に保存されました。"
              : login.status === "cancelled"
                ? "サインインを中断しました。"
                : login.error}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => void onCancel(provider.provider)}
            >
              閉じる
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={disabled}
            onClick={() => void onLogin(provider.provider)}
          >
            {view.loginLabel}
          </button>
          {view.signedIn ? (
            <span className="text-2xs text-ink-muted">すでにサインイン済みです（再サインインできます）。</span>
          ) : null}
        </div>
      )}

      {view.signOut ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-quiet"
            disabled={disabled || running}
            onClick={() => void onSignOut(provider.provider)}
          >
            サインアウト
          </button>
          <span className="text-2xs leading-relaxed text-ink-muted">
            ローカルの auth.json から削除するだけです。ChatGPT 側の接続は残るため、解除は ChatGPT
            の設定から行ってください。
          </span>
        </div>
      ) : null}

      {view.canSignIn ? <SignInInstructions /> : null}
    </section>
  );
}

/** サインイン手順の説明。この画面でサインインできない provider では出さず、理由文に置き換える */
function SignInInstructions() {
  return (
    <CollapsibleNotice summary="同じマシンのブラウザで承認する必要があります。">
      <p>
        同意画面とコールバック（<code>http://127.0.0.1:1455/auth/callback</code>）は同じマシンで開いたブラウザから
        だけ届きます。別のマシンからは、ブラウザの最後の画面の URL を貼り付けると完了できます。
      </p>
      <p>
        同じマシンで pi / Codex CLI がサインイン中だと、コールバックのポート（1455）が競合して失敗します。その
        サインインを終了してから再試行してください。
      </p>
      <p>
        サインインした資格情報は Pi の <code>auth.json</code>（この画面の DB ではありません）へ保存され、ChatGPT
        のプラン枠で推論します。SIWC はローカルの単一ユーザー向けで、公開・リモート提供・複数人での利用は できません。
      </p>
      <p>
        サインイン中はこの画面がサーバーへ状態を問い合わせ続けます。ブラウザを閉じた場合は [中断] でコールバック
        を閉じてください（そのままにするとポート 1455 を占有します）。
      </p>
      <p>サインインは開始から 10 分で自動的に中断します。</p>
    </CollapsibleNotice>
  );
}
