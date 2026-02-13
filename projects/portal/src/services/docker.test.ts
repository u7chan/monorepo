// Dockerサービスのユニットテスト

import { test, expect, mock, describe } from "bun:test";
import { parsePorts, normalizeName, parseContainer, filterContainers } from "./docker";
import type { Container, DockerContainerRaw } from "../types/container";

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

describe("parsePorts", () => {
  test("ポート文字列を正しくパースする", () => {
    const raw = "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp";
    const result = parsePorts(raw);

    expect(result).toEqual([
      { host: "0.0.0.0", publicPort: 3000, privatePort: 80, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 4000, privatePort: 443, protocol: "tcp" },
    ]);
  });

  test("単一のポートを正しくパースする", () => {
    const raw = "0.0.0.0:8080->80/tcp";
    const result = parsePorts(raw);

    expect(result).toEqual([
      { host: "0.0.0.0", publicPort: 8080, privatePort: 80, protocol: "tcp" },
    ]);
  });

  test("UDPポートを正しくパースする", () => {
    const raw = "0.0.0.0:53->53/udp";
    const result = parsePorts(raw);

    expect(result).toEqual([{ host: "0.0.0.0", publicPort: 53, privatePort: 53, protocol: "udp" }]);
  });

  test(":::形式のホストを正しくパースする", () => {
    const raw = ":::3000->80/tcp";
    const result = parsePorts(raw);

    expect(result).toEqual([{ host: "::", publicPort: 3000, privatePort: 80, protocol: "tcp" }]);
  });

  test("ポートが空文字の場合は空配列を返す", () => {
    const result = parsePorts("");
    expect(result).toEqual([]);
  });

  test("ポートが未定義の場合は空配列を返す", () => {
    const result = parsePorts(undefined as unknown as string);
    expect(result).toEqual([]);
  });

  test("無効なポート形式は無視する", () => {
    const raw = "invalid-port-format";
    const result = parsePorts(raw);
    expect(result).toEqual([]);
  });

  test("IPv4とIPv6の重複ポートを1つにまとめる", () => {
    const raw = "0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp";
    const result = parsePorts(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      host: "0.0.0.0",
      publicPort: 3000,
      privatePort: 3000,
      protocol: "tcp",
    });
  });

  test("複数ポートでIPv4/IPv6重複があっても正しくまとめる", () => {
    const raw =
      "0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp, 0.0.0.0:4000->4000/tcp, [::]:4000->4000/tcp";
    const result = parsePorts(raw);

    expect(result).toHaveLength(2);
    expect(result[0].publicPort).toBe(3000);
    expect(result[1].publicPort).toBe(4000);
  });
});

describe("normalizeName", () => {
  test("コンテナ名から先頭のスラッシュを除去する", () => {
    const result = normalizeName("/my-app");
    expect(result).toBe("my-app");
  });

  test("スラッシュがない場合はそのまま返す", () => {
    const result = normalizeName("my-app");
    expect(result).toBe("my-app");
  });

  test("複数のスラッシュは最初の1つだけ除去", () => {
    const result = normalizeName("/path/to/app");
    expect(result).toBe("path/to/app");
  });

  test("空文字はそのまま返す", () => {
    const result = normalizeName("");
    expect(result).toBe("");
  });
});

describe("parseContainer", () => {
  test("Docker生データを正しくパースする", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/my-app",
      State: "running",
      Status: "Up 2 hours",
      Image: "nginx:latest",
      Ports: "0.0.0.0:3000->80/tcp",
      CreatedAt: "2024-01-01T00:00:00Z",
      Command: "nginx -g 'daemon off;'",
    };

    const result = parseContainer(raw);

    expect(result.id).toBe("abc123def456");
    expect(result.name).toBe("my-app");
    expect(result.state).toBe("running");
    expect(result.status).toBe("Up 2 hours");
    expect(result.image).toBe("nginx:latest");
    expect(result.ports).toHaveLength(1);
    expect(result.created).toBe("2024-01-01T00:00:00Z");
    expect(result.command).toBe("nginx -g 'daemon off;'");
  });

  test("ポートが空の場合は空配列", () => {
    const raw: DockerContainerRaw = {
      ID: "def789",
      Names: "/stopped-app",
      State: "exited",
      Status: "Exited (0)",
      Image: "redis:latest",
      Ports: "",
    };

    const result = parseContainer(raw);
    expect(result.ports).toEqual([]);
  });

  test("省略可能なフィールドが欠けていても動作する", () => {
    const raw: DockerContainerRaw = {
      ID: "ghi012",
      Names: "/minimal-app",
      State: "running",
      Status: "Up",
      Image: "alpine",
      Ports: "",
    };

    const result = parseContainer(raw);
    expect(result.id).toBe("ghi012");
    expect(result.name).toBe("minimal-app");
    expect(result.created).toBe("");
    expect(result.command).toBe("");
  });

  test("Idフィールドも認識する", () => {
    const raw: DockerContainerRaw = {
      Id: "xyz789",
      Names: "/legacy-app",
      State: "running",
      Status: "Up",
      Image: "nginx",
      Ports: "",
    };

    const result = parseContainer(raw);
    expect(result.id).toBe("xyz789");
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
    expect(result[0].name).toBe("running-app");
  });

  test("stoppedフィルターは停止中のコンテナ（exited, dead）", () => {
    const result = filterContainers(containers, "stopped");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toContain("stopped-app");
    expect(result.map((c) => c.name)).toContain("dead-app");
  });

  test("空の配列に対しても動作する", () => {
    const result = filterContainers([], "all");
    expect(result).toEqual([]);
  });
});
