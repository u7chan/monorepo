import { describe, expect, test } from "bun:test";
import { judgmentErrorMessage } from "../src/client/api";

describe("judgmentErrorMessage", () => {
  test("上限・別オリジン・読めないマスタを固定文言にする", () => {
    expect(judgmentErrorMessage(413, "")).toBe("送信内容が大きすぎます");
    expect(judgmentErrorMessage(403, "")).toBe("この画面以外からの操作は受け付けません");
    expect(judgmentErrorMessage(503, "")).toBe("マスタを読めないため反映できません。再読み込みして確認してください");
  });

  test("400 は reason で案内を分け、未知の理由は入力の誤りとして扱う", () => {
    expect(judgmentErrorMessage(400, "rows")).toBe(
      "現在の enabled.json に不正な行があります。ダウンロードして直し、アップロードしてください",
    );
    expect(judgmentErrorMessage(400, "")).toBe("送信内容が不正です。画面を再読み込みしてやり直してください");
  });

  test("その他は HTTP の status を添える", () => {
    expect(judgmentErrorMessage(500, "")).toBe("反映できませんでした (HTTP 500)");
  });
});
