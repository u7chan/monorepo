const MISSING_FILE_HINT = "共通スキル配下のファイルは 設定 → スキル から開けます。";

export function filePreviewErrorHint(error: string): string | undefined {
  return error.startsWith("Path not found:") ? MISSING_FILE_HINT : undefined;
}
