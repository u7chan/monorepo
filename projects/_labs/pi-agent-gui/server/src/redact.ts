/**
 * 既知の秘密値 (プロバイダーAPIキーなど) をツール出力やストリーミング
 * テキストから取り除く純粋ユーティリティ。pi SDK に依存しない。
 *
 * 検出は完全一致のみ。正規表現やエントロピー推定による汎用検出は
 * 誤検出・過剰改変のリスクが高いため扱わない。その代わり、ストリーミング
 * では秘密値がチャンク境界をまたいでも生の値が2回の配信に分かれて現れない
 * ように、前方一致になり得る末尾を配信前に保留する。
 */

export const REDACTED = "[REDACTED]";

/**
 * これより短い値は秘密として扱わない下限。現実のAPIキーはもっと長く、
 * 極端に短い値を登録すると通常出力が過剰に改変されるため、自動解決
 * される値にのみ適用する (PI_SECRET_ENV_VARS での明示指定には適用しない)。
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * createSecretMasker の登録フィルタ。
 */
export interface SecretMaskerOptions {
  /** これより短い値を登録対象から外す (0 = 無効)。既定は 0。 */
  minLength?: number;
}

/** 保護対象の秘密値からマスカーを作る。空配列なら同一変換 (何も置換しない)。 */
export interface SecretMasker {
  /** 保護中の秘密値 (長い順・検証用の公開)。 */
  readonly secrets: readonly string[];
  /** 保護中の秘密値の最大長。ストリーミング保留幅の計算に使う。 */
  readonly maxSecretLength: number;
  /** text 中の秘密値の完全一致をすべて [REDACTED] へ置換する。 */
  mask(text: string): string;
  /**
   * 「ここまでの累積出力」のスナップショットを安全化する。完全一致の
   * 置換に加え、末尾が秘密値の前方一致になり得る分を切り落とす。
   * 累積スナップショットは後続の更新で再度渡されるため、切り落とした
   * 末尾は次の更新か最終結果で必ず再度処理される。
   */
  maskAccumulated(text: string): string;
}

export function createSecretMasker(secrets: Iterable<string>, options: SecretMaskerOptions = {}): SecretMasker {
  const minLength = options.minLength ?? 0;
  const unique = new Set<string>();
  for (const secret of secrets) {
    // 空文字や空白のみの値は split を壊す / 意味がないため常に除外。
    // 長さの下限は呼び出し側のポリシー (自動解決か明示指定か) に委ねる。
    if (typeof secret === "string" && secret.trim() !== "" && secret.length >= minLength) {
      unique.add(secret);
    }
  }
  // 長い順に置換する。ある秘密値が別の秘密値の部分一致でも、
  // 長い方を先に潰して短い方の誤置換 (取りこぼし) を防ぐ。
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
    maskAccumulated(text: string): string {
      const masked = this.mask(text);
      const hold = heldBackLength(masked, this.secrets, this.maxSecretLength);
      return hold > 0 ? masked.slice(0, masked.length - hold) : masked;
    },
  };
}

/**
 * text の末尾のうち、もう少しの入力で秘密値の先頭になり得る長さを返す。
 * 0 なら末尾は安全 (切り落とす必要がない)。
 *
 * マスク済みテキストに対して使うこと ([REDACTED] への置換後)。置換は
 * 完全一致だけを行い部分一致の末尾は残すため、末尾の数文字は元の
 * 出力と一致する。マスク済みテキスト側で照合しても部分一致の検出は
 * 保たれる (誤って保留が伸びる方向にしか倒れない)。
 */
function heldBackLength(text: string, secrets: readonly string[], maxSecretLength: number): number {
  if (secrets.length === 0 || text.length === 0) return 0;
  const maxHold = Math.min(maxSecretLength - 1, text.length);
  for (let length = maxHold; length >= 1; length -= 1) {
    const tail = text.slice(text.length - length);
    for (const secret of secrets) {
      if (secret.startsWith(tail)) {
        // サロゲートペアの中央で切らない。切る位置が低サロゲートなら
        // 直前の高サロゲートもまとめて保留する。
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

/**
 * 差分 (delta) のストリームを安全化するマスカー。秘密値がチャンク境界を
 * またぐ場合でも、生の値が配信済みテキストの連結として現れないように、
 * 秘密値の前方一致になり得る末尾を配信前に保留する。
 *
 * push() の返値を連結すると mask(全体) と等価になる (重複する秘密値で
 * トークン化が分かれる場合を除く。どちらの場合も生の値は現れない)。
 * flush() は保留中の末尾をマスクして返す。正常終了・エラー・中断の
 * いずれでも、最後に必ず一度だけ呼び出すこと。
 */
export interface StreamingSecretMasker {
  /** 差分を入力し、配信してよいテキスト (マスク済み) を返す。 */
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
 * ツール結果の content パーツ配列 (TextContent | ImageContent) のうち
 * text パーツだけをマスクする。image など text 以外のパーツはそのまま。
 * accumulated: true の場合は「ここまでの累積出力」として末尾の部分一致も
 * 切り落とす (切り落とされた分は後続の更新で再度渡される)。
 * マスク中に例外が出た場合はフェイルセーフとして全 text を [REDACTED] にする
 * (マスクに失敗した結果を生のまま返さない)。
 */
export function maskTextContentParts<T>(
  content: readonly T[] | undefined | null,
  masker: SecretMasker,
  { accumulated = false }: { accumulated?: boolean } = {},
): T[] {
  if (!Array.isArray(content)) return [];
  try {
    return content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        return {
          ...(part as { text: string }),
          text: accumulated ? masker.maskAccumulated(text) : masker.mask(text),
        };
      }
      return part;
    });
  } catch {
    return content.map(() => ({ type: "text", text: REDACTED }) as unknown as T);
  }
}
