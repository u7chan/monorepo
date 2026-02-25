// ファイルがビデオかどうかチェック
export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/');
}

// 有効な表示時間かチェック
export function isValidDuration(duration: number): boolean {
  return !isNaN(duration) && duration > 0;
}

// 有効なテロップテキストかチェック
export function isValidSubtitleText(text: string): boolean {
  return text.trim().length > 0;
}
