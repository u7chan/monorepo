// カードのフッターの 1 行・履歴の行・「今すぐ開始」の文言が、予約の状態から決まることを固定する。
import { describe, expect, test } from "bun:test";
import type { ClaudeStartState } from "../src/client/api";
import { parseClaudeStartState } from "../src/client/api";
import {
  claudeStartFooter,
  claudeStartReason,
  claudeStartRunMessage,
  describeClaudeStartRun,
} from "../src/client/lib/claude-start";

const SETTINGS = {
  anchorMinute: 22 * 60,
  count: 4,
  option: 3,
  days: [1, 2, 3, 4, 5],
  timeZone: "Asia/Tokyo",
  model: "haiku" as const,
  effort: "low" as const,
};

/**
 * 表示はブラウザのローカル時刻なので、設定のタイムゾーンを実行環境に合わせる。
 * 合わせないと、枠の計算が JST のまま期待値だけが UTC の環境で変わる。
 */
const LOCAL_SETTINGS = { ...SETTINGS, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };

function state(overrides: Partial<ClaudeStartState> = {}): ClaudeStartState {
  return {
    settings: SETTINGS,
    enabled: true,
    failures: 0,
    stoppedCode: null,
    running: false,
    nextStartAt: Date.parse("2026-11-23T07:00:00"),
    runs: [],
    ...overrides,
  };
}

describe("claudeStartFooter", () => {
  const NOW = Date.parse("2026-11-23T06:00:00");

  test("未設定・オフ（利用者が止めた）なら出さない", () => {
    expect(claudeStartFooter(null, null, NOW)).toBeNull();
    expect(claudeStartFooter(state({ settings: null }), null, NOW)).toBeNull();
    expect(claudeStartFooter(state({ enabled: false }), null, NOW)).toBeNull();
  });

  test("有効なら次の開始と、その 5 時間後のリセットを出す", () => {
    expect(claudeStartFooter(state(), null, NOW)).toEqual({
      tone: "normal",
      text: "次の開始 11/23 07:00 → 12:00 リセット",
    });
  });

  test("直前が失敗なら理由と回数を出す", () => {
    const footer = claudeStartFooter(
      state({
        failures: 1,
        runs: [{ kind: "auto", slotAt: 1, ranAt: 1, outcome: "failed", code: "reauth_required", resetsAt: null }],
      }),
      null,
      NOW,
    );

    expect(footer).toEqual({ tone: "attention", text: "開始に失敗（再ログインが必要）1/3" });
  });

  test("失敗で止まったら停止中と出す", () => {
    expect(
      claudeStartFooter(state({ enabled: false, stoppedCode: "reauth_required", failures: 3 }), null, NOW)?.tone,
    ).toBe("danger");
  });

  test("動いている窓が次の枠を潰すなら、開始できる枠と空けておく帯を出す", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-23T17:00:00") }),
      { resetsAt: Date.parse("2026-11-23T20:50:00") },
      Date.parse("2026-11-23T16:02:00"),
    );

    expect(footer).toEqual({
      tone: "hold",
      before: "次の開始 11/23 22:00（",
      band: "20:50〜22:00",
      after: " は使わない場合）→ 翌 03:00 リセット",
    });
  });

  test("窓が枠の前に終わっても、空ける時間が長ければ帯を出す", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-23T17:00:00") }),
      { resetsAt: Date.parse("2026-11-23T15:50:00") },
      Date.parse("2026-11-23T15:00:00"),
    );

    expect(footer).toEqual({
      tone: "hold",
      before: "次の開始 11/23 17:00（",
      band: "15:50〜17:00",
      after: " は使わない場合）→ 22:00 リセット",
    });
  });

  test("窓の終わりが枠とほぼ同じなら通常表示にする", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-23T17:00:00") }),
      { resetsAt: Date.parse("2026-11-23T16:58:00") },
      Date.parse("2026-11-23T16:30:00"),
    );

    expect(footer).toEqual({ tone: "normal", text: "次の開始 11/23 17:00 → 22:00 リセット" });
  });

  test("窓が終わっていれば、その時刻を過ぎた時点で通常表示に戻す", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-23T22:00:00") }),
      { resetsAt: Date.parse("2026-11-23T20:50:00") },
      Date.parse("2026-11-23T21:10:00"),
    );

    expect(footer).toEqual({ tone: "normal", text: "次の開始 11/23 22:00 → 翌 03:00 リセット" });
  });

  test("帯が日をまたぐときは「翌」を付ける", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-24T07:00:00") }),
      { resetsAt: Date.parse("2026-11-23T23:00:00") },
      Date.parse("2026-11-23T22:30:00"),
    );

    expect(footer).toEqual({
      tone: "hold",
      before: "次の開始 11/24 07:00（",
      band: "23:00〜翌 07:00",
      after: " は使わない場合）→ 12:00 リセット",
    });
  });

  test("帯が 2 日以上先まで続くなら日付ごと出す", () => {
    const footer = claudeStartFooter(
      state({ settings: LOCAL_SETTINGS, nextStartAt: Date.parse("2026-11-30T07:00:00") }),
      { resetsAt: Date.parse("2026-11-27T23:00:00") },
      Date.parse("2026-11-27T22:30:00"),
    );

    expect(footer).toEqual({
      tone: "hold",
      before: "次の開始 11/30 07:00（",
      band: "11/27 23:00〜11/30 07:00",
      after: " は使わない場合）→ 12:00 リセット",
    });
  });
});

describe("describeClaudeStartRun", () => {
  test("見送りはリセット時刻つきの理由、今すぐ開始は印を付ける", () => {
    const at = Date.parse("2026-11-20T13:10:00");

    expect(
      describeClaudeStartRun({ kind: "auto", slotAt: 0, ranAt: 0, outcome: "skipped", code: "active", resetsAt: at }),
    ).toEqual({ tone: "skip", label: "見送り", detail: "窓が動いていた（13:10 にリセット）" });
    expect(
      describeClaudeStartRun({ kind: "manual", slotAt: null, ranAt: 0, outcome: "failed", code: "x", resetsAt: null })
        .detail,
    ).toBe("今すぐ開始・Claude に送れなかった");
  });
});

describe("claudeStartRunMessage", () => {
  test("見送りは失敗として扱わない", () => {
    expect(claudeStartRunMessage({ outcome: "skipped", code: "limit_reached", resetsAt: null })).toEqual({
      failed: false,
      text: "送りませんでした（上限に達していた）。",
    });
  });

  test("実行中は待つように伝える", () => {
    expect(claudeStartRunMessage({ outcome: "error", error: "in_progress" }).text).toContain("実行中");
  });
});

describe("claudeStartReason", () => {
  test("知らないコードは一般的な文言にする", () => {
    expect(claudeStartReason("something_new")).toBe("Claude に送れなかった");
  });
});

describe("parseClaudeStartState", () => {
  test("壊れた設定は未設定として読み、形の合わない履歴の行は捨てる", () => {
    const parsed = parseClaudeStartState({
      settings: { ...SETTINGS, count: 9 },
      enabled: true,
      failures: 1,
      stoppedCode: null,
      running: false,
      nextStartAt: null,
      runs: [
        { kind: "auto", slotAt: 1, ranAt: 2, outcome: "ok", code: null, resetsAt: 3 },
        { kind: "robot", ranAt: 2, outcome: "ok" },
      ],
    });

    expect(parsed?.settings).toBeNull();
    expect(parsed?.runs).toEqual([{ kind: "auto", slotAt: 1, ranAt: 2, outcome: "ok", code: null, resetsAt: 3 }]);
  });
});
