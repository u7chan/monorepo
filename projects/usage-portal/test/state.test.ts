// snapshot と error から API の state を決める規則を固定する。
import { describe, expect, test } from "bun:test";
import { decideProviderState } from "../src/server/state";

const NOW = 1_800_000_000_000;
const INTERVAL = 300_000;

function decide(snapshotCapturedAt: number | null, hasError: boolean) {
  return decideProviderState({ snapshotCapturedAt, hasError, now: NOW, sampleIntervalMs: INTERVAL });
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

  test("2 周期を超えて更新されていなければ error が無くても stale", () => {
    expect(decide(NOW - 2 * INTERVAL, false)).toBe("ok");
    expect(decide(NOW - 2 * INTERVAL - 1, false)).toBe("stale");
  });

  test("直近の snapshot で error が無ければ ok", () => {
    expect(decide(NOW, false)).toBe("ok");
  });
});
