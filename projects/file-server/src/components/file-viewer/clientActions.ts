export const closeViewerScript =
  "document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = ''; history.pushState(null, '', '/');"

export const lockBodyScrollScript = "document.body.style.overflow = 'hidden';"

export const copyFileContentScript = `
function copyFileContent() {
  const target = document.querySelector('[data-copy-source]');
  const content = target instanceof HTMLTextAreaElement ? target.value : (target?.textContent ?? '');
  async function doCopy() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!ok) throw new Error('copy failed');
    }
  }
  doCopy().then(() => showCopyFeedback('Copied')).catch(() => showCopyFeedback('Copy failed'));
}
let copyFeedbackTimer = null;
let originalBtnHTML = null;
function showCopyFeedback(message) {
  const btn = document.getElementById('file-viewer-copy-button');
  if (!btn) return;
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  if (!originalBtnHTML) originalBtnHTML = btn.innerHTML;
  btn.innerHTML = '<span class=\\'text-xs font-semibold px-1\\'>' + message + '</span>';
  copyFeedbackTimer = setTimeout(function() { btn.innerHTML = originalBtnHTML; copyFeedbackTimer = null; }, 1500);
}
`
