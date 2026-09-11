/**
 * navigator.clipboard は Secure Context (https / localhost) 専用のため、http では
 * document.execCommand("copy") へフォールバックする (https でも権限・フォーカス等で失敗した場合を含む)。
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

  // 非表示の textarea 経由でコピーする。display:none は一部ブラウザでコピーできないため画面外へ退避し、
  // readonly はモバイルのソフトウェアキーボード抑止。
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
