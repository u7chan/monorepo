/**
 * 検出は完全一致のみ (正規表現やエントロピー推定は誤検出・過剰改変のリスクが高い)。
 * ストリーミングでは、チャンク境界で分断された秘密値が生のまま現れないよう前方一致になり得る末尾を保留する。
 */

export const REDACTED = "[REDACTED]";

/** 短い値は通常出力を過剰に改変するため、自動解決された値にのみ適用する下限 (PI_SECRET_ENV_VARS の明示指定には適用しない)。 */
export const MIN_SECRET_LENGTH = 8;

export interface SecretMaskerOptions {
  /** これより短い値を登録対象から外す (0 = 無効)。既定は 0。 */
  minLength?: number;
}

/** 空配列なら同一変換 (何も置換しない)。 */
export interface SecretMasker {
  /** 保護中の秘密値 (長い順)。 */
  readonly secrets: readonly string[];
  /** ストリーミング保留幅の計算に使う最大長。 */
  readonly maxSecretLength: number;
  /** 完全一致をすべて [REDACTED] へ置換する。 */
  mask(text: string): string;
  /** 最終結果向け。外部の切り詰めで先頭が欠けた秘密値の部分一致も置換する。 */
  maskSafe(text: string): string;
  /** 累積スナップショット向け。末尾が秘密値の前方一致になり得る分を切り落とす (切り落とした分は後続の更新で再処理される)。 */
  maskAccumulated(text: string): string;
}

export function createSecretMasker(secrets: Iterable<string>, options: SecretMaskerOptions = {}): SecretMasker {
  const minLength = options.minLength ?? 0;
  const unique = new Set<string>();
  for (const secret of secrets) {
    // 空文字や空白のみは split を壊すため除外する。長さの下限は呼び出し側のポリシーに委ねる。
    if (typeof secret === "string" && secret.trim() !== "" && secret.length >= minLength) {
      unique.add(secret);
    }
  }
  // 長い方を先に潰さないと、部分一致する短い秘密値で取りこぼす。
  const ordered = [...unique].sort((a, b) => b.length - a.length);
  const maxSecretLength = ordered[0]?.length ?? 0;
  return {
    secrets: Object.freeze(ordered),
    maxSecretLength,
    mask(text: string): string {
      if (ordered.length === 0 || !text) return text;
      let result = text;
      for (const secret of ordered) {
        if (result.includes(secret)) {
          result = result.split(secret).join(REDACTED);
        }
      }
      return result;
    },
    maskSafe(text: string): string {
      return maskTruncatedFragments(maskLeadingPartial(this.mask(text), ordered), ordered);
    },
    maskAccumulated(text: string): string {
      const masked = maskLeadingPartial(this.mask(text), ordered);
      const hold = heldBackLength(masked, this.secrets, this.maxSecretLength);
      return hold > 0 ? masked.slice(0, masked.length - hold) : masked;
    },
  };
}

/** これ以下の先頭部分一致は再構成のリスクが小さく、通常出力への誤置換を避けるため対象外。 */
export const MIN_LEADING_PARTIAL = 4;

/** SDK が grep 等の一致行に付与する行切り詰めマーカー (truncateLine) */
const TRUNCATION_MARKER = "... [truncated]";

/** 外部の切り詰め (末尾だけ残す) でキーの先頭が欠けると完全一致では検出できず、大部分が生のまま残るため先頭部分一致も置換する。 */
function maskLeadingPartial(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || text.length === 0) return text;
  let longest = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, text.length);
    for (let k = 1; k <= max; k++) {
      if (text.startsWith(secret.slice(k))) {
        longest = Math.max(longest, secret.length - k);
        break;
      }
    }
  }
  return longest >= MIN_LEADING_PARTIAL ? REDACTED + text.slice(longest) : text;
}

/** 行切り詰めマーカーの直前には、行境界で末尾を欠いたキーの切れ端が残り得るため先頭部分一致を置換する。 */
function maskTruncatedFragments(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || !text.includes(TRUNCATION_MARKER)) return text;
  let result = "";
  let rest = text;
  for (;;) {
    const markerAt = rest.indexOf(TRUNCATION_MARKER);
    if (markerAt === -1) break;
    const before = rest.slice(0, markerAt);
    let fragment = 0;
    for (const secret of secrets) {
      const max = Math.min(secret.length, before.length);
      for (let k = max; k > fragment; k--) {
        if (before.endsWith(secret.slice(0, k))) {
          fragment = k;
          break;
        }
      }
    }
    result +=
      fragment >= MIN_LEADING_PARTIAL
        ? `${before.slice(0, before.length - fragment)}${REDACTED}`
        : before;
    result += TRUNCATION_MARKER;
    rest = rest.slice(markerAt + TRUNCATION_MARKER.length);
  }
  return result + rest;
}

/** マスク済みテキストの末尾のうち、もう少しの入力で秘密値の先頭になり得る長さ (0 = 切り落とす必要なし)。置換は完全一致だけなので、マスク済み側で照合しても誤検出は保留が伸びる方向にしか倒れない。 */
function heldBackLength(text: string, secrets: readonly string[], maxSecretLength: number): number {
  if (secrets.length === 0 || text.length === 0) return 0;
  const maxHold = Math.min(maxSecretLength - 1, text.length);
  for (let length = maxHold; length >= 1; length -= 1) {
    const tail = text.slice(text.length - length);
    for (const secret of secrets) {
      if (secret.startsWith(tail)) {
        // サロゲートペアの中央で切らない (切る位置が低サロゲートなら直前の高サロゲートもまとめて保留する)。
        const cut = text.length - length;
        if (cut > 0 && isLowSurrogate(text.charCodeAt(cut)) && isHighSurrogate(text.charCodeAt(cut - 1))) {
          return length + 1;
        }
        return length;
      }
    }
  }
  return 0;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** flush() は正常終了・エラー・中断のいずれでも最後に必ず一度呼ぶこと (保留中の末尾はそこにしか残らない)。 */
export interface StreamingSecretMasker {
  /** 配信してよいマスク済みテキストを返す。 */
  push(delta: string): string;
  /** 保留中の末尾をマスクして返す。以降の push は空文字を返す。 */
  flush(): string;
}

export function createStreamingSecretMasker(masker: SecretMasker): StreamingSecretMasker {
  let buffer = "";
  return {
    push(delta: string): string {
      if (!delta) return "";
      buffer += delta;
      buffer = masker.mask(buffer);
      const hold = heldBackLength(buffer, masker.secrets, masker.maxSecretLength);
      if (hold === 0) {
        const emit = buffer;
        buffer = "";
        return emit;
      }
      const emit = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(buffer.length - hold);
      return emit;
    },
    flush(): string {
      if (!buffer) return "";
      const emit = masker.mask(buffer);
      buffer = "";
      return emit;
    },
  };
}

/**
 * content の text パーツだけをマスクする (image などはそのまま)。
 * 途中で例外が出たら、マスクできていない結果を返さないようフェイルセーフで全 text を [REDACTED] にする。
 */
export function maskTextContentParts<T>(
  content: readonly T[] | undefined | null,
  masker: SecretMasker,
  { mode = "plain" }: { mode?: "plain" | "accumulated" | "final" } = {},
): T[] {
  if (!Array.isArray(content)) return [];
  const maskText =
    mode === "accumulated"
      ? (text: string) => masker.maskAccumulated(text)
      : mode === "final"
        ? (text: string) => masker.maskSafe(text)
        : (text: string) => masker.mask(text);
  try {
    return content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return { ...(part as { text: string }), text: maskText((part as { text: string }).text) };
      }
      return part;
    });
  } catch {
    return content.map(() => ({ type: "text", text: REDACTED }) as unknown as T);
  }
}
