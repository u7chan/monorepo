// Dockerサービスのユニットテスト

import { afterEach, test, expect, mock, describe } from "bun:test";
import { ContainerActionError, runContainerAction, validateContainerAction } from "./docker";

// Bun.$ のモック
mock.module("bun", () => ({
  $: mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] || ""), "");

    // docker ps コマンドのモック
    if (cmd.includes("docker ps")) {
      return {
        text: async () =>
          JSON.stringify({
            ID: "abc123def456",
            Names: "/my-app",
            State: "running",
            Status: "Up 2 hours",
            Image: "nginx:latest",
            Ports: "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp",
          }) +
          "\n" +
          JSON.stringify({
            ID: "def789ghi012",
            Names: "/stopped-app",
            State: "exited",
            Status: "Exited (0) 3 hours ago",
            Image: "redis:latest",
            Ports: "",
          }),
        json: async () => [
          {
            ID: "abc123def456",
            Names: "/my-app",
            State: "running",
            Status: "Up 2 hours",
            Image: "nginx:latest",
            Ports: "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp",
          },
          {
            ID: "def789ghi012",
            Names: "/stopped-app",
            State: "exited",
            Status: "Exited (0) 3 hours ago",
            Image: "redis:latest",
            Ports: "",
          },
        ],
      };
    }

    throw new Error(`Unexpected command: ${cmd}`);
  }),
}));

describe("container actions", () => {
  afterEach(() => {
    delete process.env.USE_MOCK_DATA;
  });

  test("startはexited状態のコンテナを許可する", async () => {
    process.env.USE_MOCK_DATA = "true";

    const container = await validateContainerAction("ghi012jkl345678", "start");

    expect(container.name).toBe("redis-cache");
    expect(container.state).toBe("exited");
  });

  test("stopはrunning状態のコンテナを許可する", async () => {
    process.env.USE_MOCK_DATA = "true";

    const container = await validateContainerAction("abc123def456789", "stop");

    expect(container.name).toBe("nginx-proxy");
    expect(container.state).toBe("running");
  });

  test("存在しないコンテナは404エラー", async () => {
    process.env.USE_MOCK_DATA = "true";

    await expect(validateContainerAction("missing-container", "start")).rejects.toMatchObject({
      name: "ContainerActionError",
      status: 404,
    });
  });

  test("状態不一致のstartは409エラー", async () => {
    process.env.USE_MOCK_DATA = "true";

    await expect(validateContainerAction("abc123def456789", "start")).rejects.toMatchObject({
      name: "ContainerActionError",
      status: 409,
    });
  });

  test("状態不一致のstopは409エラー", async () => {
    process.env.USE_MOCK_DATA = "true";

    await expect(validateContainerAction("ghi012jkl345678", "stop")).rejects.toMatchObject({
      name: "ContainerActionError",
      status: 409,
    });
  });

  test("モックモードではDockerコマンドを呼ばず成功する", async () => {
    process.env.USE_MOCK_DATA = "true";

    await expect(runContainerAction("ghi012jkl345678", "start")).resolves.toBeUndefined();
  });

  test("操作エラーはContainerActionErrorとして扱える", async () => {
    process.env.USE_MOCK_DATA = "true";

    try {
      await validateContainerAction("missing-container", "stop");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerActionError);
    }
  });
});
