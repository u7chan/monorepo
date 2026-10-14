import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { copyToClipboard } from "../../lib/copyToClipboard";
import {
  OAUTH_COPY_DONE_TEXT,
  OAUTH_COPY_URL_TEXT,
  OAUTH_FALLBACK_LINK_TEXT,
  OAUTH_MANUAL_DESCRIPTION,
  OAUTH_MANUAL_PORT_NOTE,
  OAUTH_MANUAL_SUMMARY,
  OAUTH_NOTES,
  OAUTH_PASTE_UNAVAILABLE_NOTICE,
  OAUTH_POPUP_OPENED_NOTICE,
  OAUTH_SIGNED_IN_NOTE,
  oauthPanelView,
} from "../../lib/modelSettings";
import type { ProviderAuthSetting } from "../../types";
import { DisclosureChevronIcon } from "../icons";

export type OAuthSignInSectionProps = {
  provider: ProviderAuthSetting;
  runtimeAvailable: boolean;
  /** この provider の変更が進行中 (キーの保存などと同じフラグ) */
  busy: boolean;
  /** 見出しを出すか。認証方法のタブの中ではタブ名が同じ役割を持つ */
  heading?: boolean;
  onLogin: (provider: string) => Promise<boolean>;
  onSubmitCode: (provider: string, code: string) => Promise<boolean>;
  onCancel: (provider: string) => Promise<boolean>;
  onSignOut: (provider: string) => Promise<boolean>;
};

/**
 * provider 詳細の OAuth サインイン。進行中の主文と補助行・認可 URL・貼り付け・[中断] を出し、終端したら
 * 結果を残す (消すのは [閉じる])。表示条件とボタン名は `oauthPanelView()` が決める。
 *
 * 開始クリックで空タブを先に開き、認可 URL が届いたらそのタブを遷移させる。遷移できなかったときだけ
 * リンクへフォールバックし、自分が開いたまま遷移していないタブは失敗・中断・期限切れ・アンマウントで閉じる
 * (他のタブは閉じない)。
 */
export function OAuthSignInSection({
  provider,
  runtimeAvailable,
  busy,
  heading = true,
  onLogin,
  onSubmitCode,
  onCancel,
  onSignOut,
}: OAuthSignInSectionProps) {
  // 貼り付けは provider ごとの一時入力。provider を切り替えると親がこの要素を作り直す (key=provider)
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [popupNavigated, setPopupNavigated] = useState(false);
  // 自分が開いた空タブ。遷移済みかも同じ箱で持ち、unmount の cleanup が最新の値を見るようにする
  const popupRef = useRef<{ tab: Window; navigated: boolean } | null>(null);
  const view = oauthPanelView(provider, { popupNavigated });
  const login = view.login;
  const input = login?.input ?? null;
  const disabled = !runtimeAvailable || busy;
  const running = view.running;
  const finished = login !== null && login.status !== "running";

  const closeUnusedPopup = useCallback(() => {
    const opened = popupRef.current;
    if (!opened || opened.navigated) return;
    popupRef.current = null;
    try {
      opened.tab.close();
    } catch {
      // すでに閉じている / 操作できないタブは何もしない (表示がリンクを持っている)
    }
  }, []);

  // 認可 URL が届いたら、開始クリックで開いた空タブを遷移させる。失敗したらリンクに任せる
  useEffect(() => {
    const opened = popupRef.current;
    if (!opened || opened.navigated || view.authUrl === null) return;
    if (opened.tab.closed) {
      popupRef.current = null;
      return;
    }
    try {
      opened.tab.location.replace(view.authUrl);
      opened.navigated = true;
      setPopupNavigated(true);
    } catch {
      // 遷移できないタブ (popup を閉じられたなど) はフォールバックのリンクで開いてもらう
      popupRef.current = null;
    }
  }, [view.authUrl]);

  useEffect(() => {
    if (finished) closeUnusedPopup();
  }, [finished, closeUnusedPopup]);
  // パネルのアンマウント (provider の切替・画面の離脱) でも同じ後始末をする
  useEffect(() => closeUnusedPopup, [closeUnusedPopup]);

  // カタログ外は SDK がログインを受けない。hooks を揃えた後に落とす (props の変化で呼び出し数が変わらない)
  if (!view.visible) return null;

  const start = async () => {
    // 空タブはユーザー操作の中で開く (await の後では popup blocker に止められる)。
    // 前回の空タブが残っていればそれを遷移先に使う (遷移済みのタブは自分の後始末の対象外)
    const previous = popupRef.current;
    const reusable = previous && !previous.navigated && !previous.tab.closed ? previous.tab : null;
    const tab = reusable ?? window.open("about:blank", "_blank");
    popupRef.current = tab ? { tab, navigated: false } : null;
    setPopupNavigated(false);
    if (!(await onLogin(provider.provider))) closeUnusedPopup();
  };

  const submitCode = async () => {
    // 送れたときだけ入力を消す (失敗したら貼り付け直せるように残す)
    if (await onSubmitCode(provider.provider, code)) setCode("");
  };

  const copyAuthUrl = async () => {
    if (view.authUrl === null) return;
    try {
      await copyToClipboard(view.authUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // コピーできない環境では、表示中のリンクから手でコピーできる (導線は残す)
    }
  };

  return (
    <section className="grid gap-1.5">
      {heading ? (
        <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">OAuth サインイン</div>
      ) : null}
      {!view.canSignIn ? (
        <p className="text-2xs leading-relaxed text-ink-muted">{view.unsupportedNotice}</p>
      ) : running ? (
        <div className="grid gap-1.5 rounded-md border border-line bg-soft px-2.5 py-2">
          {view.instructions ? <p className="text-2xs leading-relaxed text-ink">{view.instructions}</p> : null}
          {view.progress ? <p className="text-2xs leading-relaxed text-ink-muted">{view.progress}</p> : null}
          {view.showPopupNotice ? (
            <p className="text-2xs leading-relaxed text-ink-muted">
              {view.loginLabel}
              {OAUTH_POPUP_OPENED_NOTICE}
            </p>
          ) : null}
          {view.showFallbackLink && view.authUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <a href={view.authUrl} target="_blank" rel="noreferrer noopener" className="text-2xs text-accent-text">
                {OAUTH_FALLBACK_LINK_TEXT}
              </a>
              {/* 折りたたみを出さない副状態 (デバイスコード) では、コピーの導線をリンクの隣に出す */}
              {view.showManual ? null : (
                <button type="button" className="btn-quiet" onClick={() => void copyAuthUrl()}>
                  {copied ? OAUTH_COPY_DONE_TEXT : OAUTH_COPY_URL_TEXT}
                </button>
              )}
            </div>
          ) : null}
          {view.userCode ? (
            <p className="text-2xs leading-relaxed text-ink">
              コード: <code className="text-ink-strong">{view.userCode}</code>
            </p>
          ) : null}
          {view.showManual ? (
            <details className="rounded-md border border-line bg-raised text-2xs leading-relaxed text-ink-muted">
              <summary className="disclosure-summary flex cursor-pointer items-start gap-1.5 px-2.5 py-1.5 transition-colors outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
                <span className="mt-0.5">
                  <DisclosureChevronIcon />
                </span>
                <span className="min-w-0 flex-1 break-words">{OAUTH_MANUAL_SUMMARY}</span>
              </summary>
              <div className="grid gap-1.5 px-2.5 pb-2">
                <p>{OAUTH_MANUAL_DESCRIPTION}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={!view.canCopyUrl}
                    onClick={() => void copyAuthUrl()}
                  >
                    {copied ? OAUTH_COPY_DONE_TEXT : OAUTH_COPY_URL_TEXT}
                  </button>
                </div>
                {view.showPasteForm && input ? (
                  <form
                    className="grid gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitCode();
                    }}
                  >
                    <label className="grid gap-1 text-2xs text-ink-soft">
                      {input.message}
                      <input
                        className="field min-w-0 text-xs"
                        value={code}
                        placeholder={input.placeholder}
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
                ) : view.showPasteUnavailable ? (
                  <p>{OAUTH_PASTE_UNAVAILABLE_NOTICE}</p>
                ) : null}
                <p>{OAUTH_MANUAL_PORT_NOTE}</p>
              </div>
            </details>
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
            className={cn(
              "rounded-md px-2.5 py-1.5 text-2xs leading-relaxed",
              login.status === "failed" ? "border border-warn/40 bg-raised text-warn" : "text-ink-muted",
            )}
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
        <div className="grid gap-1.5">
          {view.notice ? <p className="text-2xs leading-relaxed text-ink-muted">{view.notice}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={disabled} onClick={() => void start()}>
              {view.loginLabel}
            </button>
            {view.signedIn ? <span className="text-2xs text-ink-muted">{OAUTH_SIGNED_IN_NOTE}</span> : null}
          </div>
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

      {view.canSignIn ? <OAuthNotes /> : null}
    </section>
  );
}

/** 常時表示の注意 (期限と利用条件)。押す前に読めるよう、折りたたみの外へ出す */
function OAuthNotes() {
  return (
    <div className="grid gap-0.5 text-2xs leading-relaxed text-ink-muted">
      {OAUTH_NOTES.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}
