/** 画面で選べるアイコン。画像を持たせず、絵文字だけで識別する（プリセットから外れた値は受け付けない）。 */
export const OPENCODE_ACCOUNT_ICONS = ["🦊", "🐼", "🐧", "🐳", "🦉", "🐙", "🦅", "🐸", "🦄", "🐝", "🐯", "🐨"] as const;

export type OpenCodeAccountIcon = (typeof OPENCODE_ACCOUNT_ICONS)[number];

/** 上限。上流アクセスは 5 分 × 件数になるため、1 時間あたりの呼び出しを抑える。 */
export const MAX_OPENCODE_ACCOUNTS = 10;

/**
 * 名前は UTF-16 の長さではなくコードポイントで数える。絵文字を含む名前で
 * 見た目より短く切られるのを避けるため。
 */
export const MAX_OPENCODE_ACCOUNT_NAME_LENGTH = 40;

/** 1 KiB の body 制限に収まる上限。現実のキーはこれより十分短い。 */
export const MAX_OPENCODE_API_KEY_LENGTH = 512;

export function isOpenCodeAccountIcon(value: unknown): value is OpenCodeAccountIcon {
  return typeof value === "string" && (OPENCODE_ACCOUNT_ICONS as readonly string[]).includes(value);
}

/** 前後の空白を落として 1〜40 コードポイント。制御文字は表示が崩れるため受け付けない。 */
export function normalizeAccountName(value: string): string | null {
  const name = value.trim();
  const length = [...name].length;

  if (length === 0 || length > MAX_OPENCODE_ACCOUNT_NAME_LENGTH) {
    return null;
  }

  for (const char of name) {
    if (isControlCharacter(char.codePointAt(0) ?? 0)) {
      return null;
    }
  }

  return name;
}

/** 改行や制御文字を Authorization ヘッダーへ通さない。空白入りはコピー時の混入として弾く。 */
export function normalizeApiKey(value: string): string | null {
  const key = value.trim();

  if (key === "" || [...key].length > MAX_OPENCODE_API_KEY_LENGTH) {
    return null;
  }

  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;

    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }

  return key;
}

function isControlCharacter(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}
