// 名前・アイコン・API キーの入力規則（コードポイント数、制御文字、プリセット）を固定する。
import { describe, expect, test } from "bun:test";
import {
  MAX_OPENCODE_ACCOUNT_NAME_LENGTH,
  OPENCODE_ACCOUNT_ICONS,
  isOpenCodeAccountIcon,
  normalizeAccountName,
  normalizeApiKey,
} from "../src/shared/opencode-account";

describe("OPENCODE_ACCOUNT_ICONS", () => {
  test("12 種のプリセットだけで、重複が無い", () => {
    expect(OPENCODE_ACCOUNT_ICONS).toHaveLength(12);
    expect(new Set(OPENCODE_ACCOUNT_ICONS).size).toBe(12);
    expect(isOpenCodeAccountIcon("🦊")).toBe(true);
    expect(isOpenCodeAccountIcon("🚀")).toBe(false);
    expect(isOpenCodeAccountIcon(null)).toBe(false);
  });
});

describe("normalizeAccountName", () => {
  test("前後の空白を落とし、40 コードポイントまでを受け付ける", () => {
    expect(normalizeAccountName("  メイン  ")).toBe("メイン");
    expect(normalizeAccountName("あ".repeat(MAX_OPENCODE_ACCOUNT_NAME_LENGTH))).toBe("あ".repeat(40));
    expect(normalizeAccountName("あ".repeat(41))).toBeNull();
    expect(normalizeAccountName("   ")).toBeNull();
  });

  test("絵文字はコードポイントで数える", () => {
    // UTF-16 では 2 単位になるため、.length で数えると 20 文字で落ちる。
    expect(normalizeAccountName("🦊".repeat(40))).toBe("🦊".repeat(40));
    expect(normalizeAccountName("🦊".repeat(41))).toBeNull();
  });

  test("制御文字を含む名前は受け付けない", () => {
    expect(normalizeAccountName("メイン\n2")).toBeNull();
    expect(normalizeAccountName("メイン\t2")).toBeNull();
    expect(normalizeAccountName(`メイン${String.fromCodePoint(0x7f)}`)).toBeNull();
    expect(normalizeAccountName(`メイン${String.fromCodePoint(0x85)}`)).toBeNull();
  });
});

describe("normalizeApiKey", () => {
  test("前後の空白を落とし、内部の空白・制御文字・長すぎる値を弾く", () => {
    expect(normalizeApiKey("  sk-sentinel  ")).toBe("sk-sentinel");
    expect(normalizeApiKey("   ")).toBeNull();
    expect(normalizeApiKey("sk key")).toBeNull();
    expect(normalizeApiKey("sk-key\nx")).toBeNull();
    expect(normalizeApiKey("a".repeat(512))).toBe("a".repeat(512));
    expect(normalizeApiKey("a".repeat(513))).toBeNull();
  });
});
