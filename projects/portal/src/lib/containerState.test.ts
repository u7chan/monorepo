// containerState.ts の仕様: どの状態で何が押せて、どの色で示すか

import { describe, expect, test } from "bun:test";
import {
  filterContainers,
  getContainerAction,
  getStatusTone,
  isPortReachable,
  matchesContainerFilter,
} from "./containerState";
import type { Container, ContainerFilter } from "../types/container";

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

describe("matchesContainerFilter", () => {
  function withState(state: Container["state"]): Container {
    return {
      id: "1",
      name: state,
      image: "nginx",
      state,
      status: "",
      ports: [],
    };
  }

  test("running は running のときだけ true", () => {
    expect(matchesContainerFilter(withState("running"), "running")).toBe(true);
    expect(matchesContainerFilter(withState("exited"), "running")).toBe(false);
  });

  test("stopped は exited と dead だけ true", () => {
    expect(matchesContainerFilter(withState("exited"), "stopped")).toBe(true);
    expect(matchesContainerFilter(withState("dead"), "stopped")).toBe(true);
    expect(matchesContainerFilter(withState("paused"), "stopped")).toBe(false);
    expect(matchesContainerFilter(withState("running"), "stopped")).toBe(false);
  });

  test("all と未知の filter はどの状態でも true", () => {
    for (const state of states) {
      expect(matchesContainerFilter(withState(state), "all")).toBe(true);
      expect(matchesContainerFilter(withState(state), "unknown" as ContainerFilter)).toBe(true);
    }
  });
});

describe("filterContainers", () => {
  const containers: Container[] = [
    {
      id: "1",
      name: "running-app",
      image: "nginx",
      state: "running",
      status: "Up",
      ports: [],
    },
    {
      id: "2",
      name: "stopped-app",
      image: "redis",
      state: "exited",
      status: "Exited",
      ports: [],
    },
    {
      id: "3",
      name: "dead-app",
      image: "postgres",
      state: "dead",
      status: "Dead",
      ports: [],
    },
    {
      id: "4",
      name: "paused-app",
      image: "mysql",
      state: "paused",
      status: "Paused",
      ports: [],
    },
  ];

  test("allフィルターは全てのコンテナを返す", () => {
    const result = filterContainers(containers, "all");
    expect(result).toHaveLength(4);
  });

  test("runningフィルターは実行中のコンテナのみ", () => {
    const result = filterContainers(containers, "running");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("running-app");
  });

  test("stoppedフィルターは停止中のコンテナ（exited, dead）", () => {
    const result = filterContainers(containers, "stopped");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toContain("stopped-app");
    expect(result.map((c) => c.name)).toContain("dead-app");
  });

  test("paused は stopped フィルターに含めない", () => {
    const result = filterContainers(containers, "stopped");
    expect(result.map((c) => c.name)).not.toContain("paused-app");
  });

  test("未知のフィルターは all として返す", () => {
    const result = filterContainers(containers, "unknown" as ContainerFilter);
    expect(result).toHaveLength(4);
  });

  test("空の配列に対しても動作する", () => {
    const result = filterContainers([], "all");
    expect(result).toEqual([]);
  });
});
