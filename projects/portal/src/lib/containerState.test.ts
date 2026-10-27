// containerState.ts の仕様: どの状態で何が押せて、どの色で示すか

import { describe, expect, test } from "bun:test";
import { getContainerAction, getStatusTone, isPortReachable } from "./containerState";
import type { Container } from "../types/container";

const states: Container["state"][] = [
  "running",
  "exited",
  "dead",
  "paused",
  "restarting",
  "removing",
];

describe("isPortReachable", () => {
  test("running のときだけポートを点灯させる", () => {
    expect(states.filter((state) => isPortReachable(state))).toEqual(["running"]);
  });
});

describe("getContainerAction", () => {
  test("running は stop、exited は start を返す", () => {
    expect(getContainerAction("running")).toBe("stop");
    expect(getContainerAction("exited")).toBe("start");
  });

  test("サーバー側が拒否する状態では操作を出さない", () => {
    // validateContainerAction は paused / restarting / dead を 409 で弾くため、
    // 押しても失敗するボタンを画面に出さない
    expect(getContainerAction("paused")).toBeNull();
    expect(getContainerAction("restarting")).toBeNull();
    expect(getContainerAction("dead")).toBeNull();
    expect(getContainerAction("removing")).toBeNull();
  });
});

describe("getStatusTone", () => {
  test("状態ごとに 1 つの色の役割を返す", () => {
    expect(getStatusTone("running")).toBe("live");
    expect(getStatusTone("exited")).toBe("dead");
    expect(getStatusTone("dead")).toBe("dead");
    expect(getStatusTone("paused")).toBe("warn");
    expect(getStatusTone("restarting")).toBe("info");
    expect(getStatusTone("removing")).toBe("idle");
  });
});
