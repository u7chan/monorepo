/**
 * 履歴に残る `/skill:` の展開結果 (`<skill name="…" location="…">本文</skill>`) の分解。
 * 形式の正はサーバー (server/src/session-skills.ts) で、SDK の `_expandSkillCommand` /
 * `parseSkillBlock` と互換の形にする。ここは表示 (バブルを畳む) と、送信エコーの照合だけを担う。
 */

export interface SkillBlock {
  name: string;
  /** read と同じ場所。ファイル / 組み込み / カタログとも絶対パス (仮想パスを含む) */
  location: string;
  /** スキル本文 (frontmatter 抜き)。「References are relative to …」の 1 行は含めない */
  content: string;
  /** ブロックの後ろに続くユーザーの引数 */
  userMessage?: string;
}

/**
 * SDK の `parseSkillBlock` と同じ形に加え、カタログスキル (baseDir が無い) の
 * 「References are relative to …」行が無い形も受ける。
 */
const SKILL_BLOCK_PATTERN =
  /^<skill name="([^"]+)" location="([^"]+)">\n(?:References are relative to [^\n]+\.\n\n)?([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** 先頭がスキルブロックなら分解する。違えば null (通常の本文はそのまま表示する) */
export function splitSkillBlock(text: string): SkillBlock | null {
  const match = text.match(SKILL_BLOCK_PATTERN);
  if (!match) return null;
  const userMessage = match[4]?.trim();
  return {
    name: match[1] as string,
    location: match[2] as string,
    content: match[3] as string,
    ...(userMessage ? { userMessage } : {}),
  };
}

/**
 * 送信エコーの照合用の正規形。展開済みのブロックを、ユーザーが打った形 (`/skill:name 引数`) に戻す。
 * ローカルエコーは素の入力、`run_start` は展開後の本文で届くため、両者をこの形に寄せて突き合わせる。
 */
export function skillCommandForm(text: string): string {
  const block = splitSkillBlock(text);
  if (!block) return text;
  return block.userMessage ? `/skill:${block.name} ${block.userMessage}` : `/skill:${block.name}`;
}
