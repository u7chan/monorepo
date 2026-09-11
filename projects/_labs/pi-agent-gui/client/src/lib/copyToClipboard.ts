/**
 * クリップボードへテキストをコピーする。
 *
 * navigator.clipboard は Secure Context (https / localhost) 専用のため、
 * http 環境では document.execCommand("copy") にフォールバックする。
 * https でも writeText が失敗した場合 (権限・フォーカス等) はフォールバックを試す。
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // フォールバックへ
    }
  }

  // 非表示の textarea 経由でコピーする。
  // display:none だと一部ブラウザでコピーされないため画面外へ退避する。
  // readonly はモバイルでのソフトウェアキーボード抑止。
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("クリップボードへのコピーに失敗しました");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
