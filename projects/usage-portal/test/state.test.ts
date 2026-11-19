// snapshot と error から API の state を決める規則を固定する。
import { describe, expect, test } from "bun:test";
import { decideProviderState } from "../src/server/state";

const NOW = 1_800_000_000_000;
const STALE_AFTER = 600_000;
const CLAUDE_STALE_AFTER = 900_000;

function decide(snapshotCapturedAt: number | null, hasError: boolean, staleAfterMs = STALE_AFTER) {
  return decideProviderState({ snapshotCapturedAt, hasError, now: NOW, staleAfterMs });
}

describe("decideProviderState", () => {
  test("snapshot が無く error も無ければ loading", () => {
    expect(decide(null, false)).toBe("loading");
  });

  test("snapshot が無く error があれば error", () => {
    expect(decide(null, true)).toBe("error");
  });

  test("snapshot があって error があれば stale", () => {
    expect(decide(NOW - 1000, true)).toBe("stale");
  });

  test("閾値を超えて更新されていなければ error が無くても stale", () => {
    expect(decide(NOW - STALE_AFTER, false)).toBe("ok");
    expect(decide(NOW - STALE_AFTER - 1, false)).toBe("stale");
  });

  test("閾値は provider ごとに渡せる（Claude は 15 分）", () => {
    expect(decide(NOW - CLAUDE_STALE_AFTER, false, CLAUDE_STALE_AFTER)).toBe("ok");
    expect(decide(NOW - CLAUDE_STALE_AFTER - 1, false, CLAUDE_STALE_AFTER)).toBe("stale");
    // 同じ古さでも、周期取得の閾値では stale になる。
    expect(decide(NOW - CLAUDE_STALE_AFTER, false)).toBe("stale");
  });

  test("直近の snapshot で error が無ければ ok", () => {
    expect(decide(NOW, false)).toBe("ok");
  });
});
