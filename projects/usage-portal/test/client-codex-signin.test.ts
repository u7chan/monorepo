// Codex パネルの操作の出し分けを固定する（成功状態が残っていても復帰できること）。
import { describe, expect, test } from "bun:test";
import { showsSignOutButton, showsStartButton, type CodexPanelVisibility } from "../src/client/lib/codex-signin";

function visibility(overrides: Partial<CodexPanelVisibility> = {}): CodexPanelVisibility {
  return { known: true, needsSignIn: false, signedIn: true, loginStatus: null, ...overrides };
}

describe("showsStartButton", () => {
  test("サインイン済みで終端も無ければ出さない", () => {
    expect(showsStartButton(visibility())).toBe(false);
    expect(showsStartButton(visibility({ loginStatus: "succeeded" }))).toBe(false);
  });

  test("サインアウト後に成功状態が残っていても開始できる", () => {
    expect(showsStartButton(visibility({ signedIn: false, loginStatus: "succeeded" }))).toBe(true);
  });

  test("再サインインが必要なら、サインイン済みでも開始できる", () => {
    expect(showsStartButton(visibility({ needsSignIn: true }))).toBe(true);
    expect(showsStartButton(visibility({ needsSignIn: true, loginStatus: "succeeded" }))).toBe(true);
  });

  test("未接続・失敗・中断では開始できる", () => {
    expect(showsStartButton(visibility({ signedIn: false }))).toBe(true);
    expect(showsStartButton(visibility({ signedIn: false, loginStatus: "failed" }))).toBe(true);
    expect(showsStartButton(visibility({ loginStatus: "cancelled" }))).toBe(true);
  });

  test("進行中と、認証状態の取得前は出さない", () => {
    expect(showsStartButton(visibility({ signedIn: false, loginStatus: "running" }))).toBe(false);
    expect(showsStartButton(visibility({ known: false, signedIn: false }))).toBe(false);
  });
});

describe("showsSignOutButton", () => {
  test("有効な資格情報があって進行中でなければ出す", () => {
    expect(showsSignOutButton(visibility())).toBe(true);
    expect(showsSignOutButton(visibility({ loginStatus: "failed" }))).toBe(true);
  });

  test("未接続・再サインイン・進行中・取得前は出さない", () => {
    expect(showsSignOutButton(visibility({ signedIn: false }))).toBe(false);
    expect(showsSignOutButton(visibility({ needsSignIn: true }))).toBe(false);
    expect(showsSignOutButton(visibility({ loginStatus: "running" }))).toBe(false);
    expect(showsSignOutButton(visibility({ known: false }))).toBe(false);
  });
});
