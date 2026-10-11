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
      // 権限・フォーカス等で失敗した場合は textarea 経由へ
    }
  }

  // 非表示の textarea 経由でコピーする。display:none は一部ブラウザでコピーできないため画面外へ退避し、
  // readonly はモバイルのソフトウェアキーボード抑止。
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  copyHost().appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    // inert の中 (showModal した dialog の外) では focus も選択も通らず、execCommand("copy") は
    // true を返しても空振りする。コピーできていないのに成功を返さないよう成否を確かめる
    if (document.activeElement !== textarea || !document.execCommand("copy")) {
      throw new Error("クリップボードへのコピーに失敗しました");
    }
  } finally {
    textarea.remove();
  }
}

/**
 * フォールバックの textarea を置く先。showModal() した dialog はその外側を inert にするため、body 直下へ
 * 置くと focus できず、選択も作れない (開いている dialog の中へ入れる)。
 */
function copyHost(): HTMLElement {
  const active = document.activeElement;
  const focused = active instanceof Element ? active.closest<HTMLDialogElement>("dialog[open]") : null;
  if (focused !== null) return focused;
  const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  return open[open.length - 1] ?? document.body;
}
