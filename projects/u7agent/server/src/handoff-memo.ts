/**
 * 引き継ぎメモ (HANDOFF.md へ先頭追記する 1 節) の組み立て。材料は保存済みの会話 (JSONL の entry) だけで、
 * ライブの SDK セッションの messages は使わない (再起動の前後で同じメモになる)。全文を mask してから
 * 長さで切る (境界をまたぐ秘密値を残さない)。
 */
import { createHash } from "node:crypto";
import { formatJstDateTime, JST_TIME_ZONE } from "./jst";
import type { SecretMasker } from "./redact";
import { contentText } from "./session-projection";
import type { SessionEntryLike } from "./session-store";

/** 作業フォルダ直下の固定名。プロジェクト所属ではリポジトリ直下にできる */
export const HANDOFF_FILE_NAME = "HANDOFF.md";
/** 1 回の追記分の上限 (文字数)。超えたら古い方から落とし、見出しと末尾の依頼行は残す */
export const HANDOFF_SECTION_MAX = 6000;
/** 直近のやり取りに載せる最大件数 (新しい方から) */
export const HANDOFF_RECENT_MAX = 6;
/** 1 件のやり取りの上限 (文字数) */
export const HANDOFF_MESSAGE_MAX = 1200;
const HANDOFF_SUMMARY_MAX = 2400;
/** 末尾の依頼行。人とエージェントの両方が読む固定文 */
export const HANDOFF_CLOSING = "この続きをお願いします。";

export interface HandoffMessage {
  /** 表示と同じ役割名 (user / assistant) */
  role: "user" | "assistant";
  text: string;
}

export interface HandoffMemoSection {
  /**
   * 冪等化の鍵。先頭行にこの値が含まれるとき、サンドボックスは追記しない。操作 ID は再試行のたびに
   * 変わるため、材料 (会話・タイトル・エージェント名) から決まる値にする。
   */
  hash: string;
  /** 先頭へ追記する 1 節 (末尾は空行で終わる) */
  text: string;
}

export interface HandoffMemoInput {
  entries: SessionEntryLike[];
  title: string;
  fromAgent: string;
  toAgent: string;
  operationId: string;
  /** 節の日時 (epoch ms) */
  at: number;
  masker: SecretMasker;
}

/**
 * 保存済みの entry から直近のやり取り (user / assistant のテキストのみ) を取る。新しい方から最大
 * `HANDOFF_RECENT_MAX` 件で、戻り値は古い→新しい。ツールの実行結果・thinking・usage は含めない。
 */
export function handoffRecentMessages(entries: SessionEntryLike[], masker: SecretMasker): HandoffMessage[] {
  const messages: HandoffMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const masked = masker.mask(contentText(message.content)).trim();
    if (masked === "") continue;
    messages.push({
      role: message.role,
      text: masked.length > HANDOFF_MESSAGE_MAX ? masked.slice(0, HANDOFF_MESSAGE_MAX) : masked,
    });
  }
  return messages.slice(-HANDOFF_RECENT_MAX);
}

/** 最新の compaction 要約 (あれば)。全文を mask してから長さで切る */
export function handoffCompactionSummary(entries: SessionEntryLike[], masker: SecretMasker): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "compaction" || typeof entry.summary !== "string") continue;
    const masked = masker.mask(entry.summary).trim();
    if (masked === "") return "";
    return masked.length > HANDOFF_SUMMARY_MAX ? masked.slice(0, HANDOFF_SUMMARY_MAX) : masked;
  }
  return "";
}

/**
 * メモ 1 節を組み立てる。材料が無い (user / assistant のテキストが 1 件も無い) ときは undefined を返し、
 * 呼び出し側が「メモを作らずに引き継ぐ」案内つきの 400 にする。
 */
export function buildHandoffSection(input: HandoffMemoInput): HandoffMemoSection | undefined {
  const recent = handoffRecentMessages(input.entries, input.masker);
  if (recent.length === 0) return undefined;
  const summary = handoffCompactionSummary(input.entries, input.masker);
  const title = input.masker.mask(input.title).trim() || "無題のセッション";
  // 操作 ID と日時は含めない (再試行でも同じ値になるようにする)。引き継ぎ先が変われば別の節になる
  const material = [input.fromAgent, input.toAgent, title, summary, ...recent.map(messageLine)].join("\n");
  const hash = createHash("sha256").update(material).digest("hex").slice(0, 16);
  const header = [
    `# 引き継ぎメモ (本文ハッシュ: ${hash})`,
    "",
    `- 日時: ${formatJstDateTime(input.at)} (${JST_TIME_ZONE})`,
    `- 操作 ID: ${input.operationId}`,
    `- 引き継ぎ: ${input.masker.mask(input.fromAgent)} → ${input.masker.mask(input.toAgent)}`,
    `- 元の会話タイトル: ${title}`,
    "",
  ].join("\n");
  const render = (summaryText: string, messages: HandoffMessage[]): string => {
    const parts: string[] = [];
    if (summaryText !== "") parts.push(`## これまでの経緯\n\n${summaryText}`);
    if (messages.length > 0) {
      parts.push(`## 直近のやり取り\n\n${messages.map((item) => `### ${item.role}\n\n${item.text}`).join("\n\n")}`);
    }
    return `${header}${parts.join("\n\n")}\n\n${HANDOFF_CLOSING}\n\n`;
  };

  let summaryText = summary;
  const messages = [...recent];
  // 超えたら古いやり取りごと落とす。1 件だけになってなお超えるときは、その 1 件を末尾から削る
  // (見出しと依頼行は残す)
  while (messages.length > 0 && render(summaryText, messages).length > HANDOFF_SECTION_MAX) {
    if (messages.length > 1) {
      messages.shift();
      continue;
    }
    const overflow = render(summaryText, messages).length - HANDOFF_SECTION_MAX;
    const oldest = messages[0];
    if (oldest.text.length > overflow) {
      messages[0] = { ...oldest, text: oldest.text.slice(0, oldest.text.length - overflow) };
      break;
    }
    messages.shift();
  }
  if (render(summaryText, messages).length > HANDOFF_SECTION_MAX && summaryText !== "") {
    const overflow = render(summaryText, messages).length - HANDOFF_SECTION_MAX;
    summaryText = summaryText.slice(0, Math.max(0, summaryText.length - overflow));
  }
  return { hash, text: render(summaryText, messages) };
}

function messageLine(message: HandoffMessage): string {
  return `### ${message.role}\n\n${message.text}`;
}
