// 秒数を時:分:秒.ミリ秒形式に変換
export function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

// テキストから自動的に表示時間を計算（1文字あたり0.25秒、最低0.5秒）
export function calculateDuration(text: string): number {
  return Math.max(0.5, text.length / 4);
}

// HTMLエスケープ
export function escapeHTML(str: string): string {
  return str.replace(new RegExp("[&<>'\"]", "g"), function (match) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[match] ?? match;
  });
}

// 改行を<br>に変換
export function nl2br(str: string): string {
  return escapeHTML(str).replace(/\n/g, '<br>');
}
