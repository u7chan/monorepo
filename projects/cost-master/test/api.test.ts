import { describe, expect, test } from "bun:test";
import { judgmentErrorMessage, masterUnavailableMessage } from "../src/client/api";
import { isMasterFailure, MASTER_FAILURES } from "../src/shared/contract";

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

describe("masterUnavailableMessage", () => {
  test("理由ごとに、次に何をすればよいかを固定文言で返す", () => {
    // 空の一覧を配らずに 503 へ倒したとき、画面はここだけを見せる（ログを開かせない）
    expect(masterUnavailableMessage("prices-missing", 0)).toContain("prices.json がありません");
    expect(masterUnavailableMessage("enabled-missing", 0)).toContain("enabled.json がありません");
    expect(masterUnavailableMessage("prices-unreadable", 0)).toContain("prices.json を読めません");
    expect(masterUnavailableMessage("enabled-unreadable", 0)).toContain("enabled.json を読めません");
  });

  test("全行が落ちたときは行数とアップロードの案内を出す", () => {
    // 旧語彙の prices.json を置き去りにしたまま再デプロイした場合の文言
    const message = masterUnavailableMessage("prices-no-usable-rows", 147);

    expect(message).toContain("147 行");
    expect(message).toContain("新しい prices.json をアップロード");
  });

  test("行数が分からないときと理由が無いときも、次の行動を示す", () => {
    expect(masterUnavailableMessage("prices-no-usable-rows", undefined)).toContain("新しい prices.json");
    expect(masterUnavailableMessage(undefined, undefined)).toContain("サーバーのログ");
  });
});

describe("isMasterFailure", () => {
  test("語彙の外の値は理由として扱わない", () => {
    for (const failure of MASTER_FAILURES) {
      expect(isMasterFailure(failure)).toBe(true);
    }

    expect(isMasterFailure("master_unavailable")).toBe(false);
    expect(isMasterFailure(undefined)).toBe(false);
  });
});
