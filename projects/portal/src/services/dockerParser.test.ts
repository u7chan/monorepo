import { describe, expect, test } from "bun:test";
import type { Container, DockerContainerRaw } from "../types/container";
import {
  excludePortalContainers,
  isPortalContainer,
  normalizeName,
  parseContainer,
  parseContainerList,
  parsePorts,
} from "./dockerParser";

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
    expect(result[0]!.publicPort).toBe(3000);
    expect(result[1]!.publicPort).toBe(4000);
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

  test("Labels の portal.url.<ポート> を urls に変換する", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/caddy",
      State: "running",
      Status: "Up 2 hours",
      Image: "caddy:2",
      Ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
      Labels: "portal.url.80=http://portal.home.arpa,portal.url.443=https://portal.home.arpa",
    };

    expect(parseContainer(raw).urls).toEqual({
      80: "http://portal.home.arpa",
      443: "https://portal.home.arpa",
    });
  });

  test("portal.url ラベルがなければ urls は undefined", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/my-app",
      State: "running",
      Status: "Up",
      Image: "nginx:latest",
      Ports: "0.0.0.0:3000->80/tcp",
      Labels: "com.docker.compose.service=my-app",
    };

    expect(parseContainer(raw).urls).toBeUndefined();
  });

  test("不正な portal.url ラベルは urls に含めない", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/my-app",
      State: "running",
      Status: "Up",
      Image: "nginx:latest",
      Ports: "0.0.0.0:3000->80/tcp",
      Labels: "portal.url.abc=https://ignored.example,portal.url.3000=",
    };

    expect(parseContainer(raw).urls).toBeUndefined();
  });

  test("Labels の portal.url と portal.hidden をコンテナへ写す", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/caddy",
      State: "running",
      Status: "Up",
      Image: "caddy:2",
      Ports: "0.0.0.0:80->80/tcp",
      Labels: "portal.url=https://app.home.arpa,portal.hidden=true",
    };

    const container = parseContainer(raw);

    expect(container.url).toBe("https://app.home.arpa");
    expect(container.hidden).toBe(true);
    expect(container.urls).toBeUndefined();
  });

  test("portal.url のラベルがなければ url は undefined", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/my-app",
      State: "running",
      Status: "Up",
      Image: "nginx:latest",
      Ports: "0.0.0.0:3000->80/tcp",
      Labels: "com.docker.compose.service=my-app",
    };

    const container = parseContainer(raw);

    expect(container.url).toBeUndefined();
    expect(container.hidden).toBeUndefined();
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

describe("excludePortalContainers", () => {
  const baseContainer: Container = {
    id: "a1b2c3d4e5f6",
    name: "some-app",
    image: "nginx:latest",
    state: "running",
    status: "Up",
    ports: [],
  };

  test("portal のイメージ（タグ付き）は除外する", () => {
    const portal: Container = {
      ...baseContainer,
      id: "111111111111",
      name: "portal",
      image: "ghcr.io/u7chan/monorepo/portal:latest",
    };

    expect(excludePortalContainers([portal, baseContainer], "ubuntu-host")).toEqual([
      baseContainer,
    ]);
  });

  test("portal のイメージ（ダイジェスト指定）も除外する", () => {
    const portal: Container = {
      ...baseContainer,
      id: "222222222222",
      image: "ghcr.io/u7chan/monorepo/portal@sha256:abc123",
    };

    expect(isPortalContainer(portal, "ubuntu-host")).toBe(true);
  });

  test("同じレジストリでも別イメージは除外しない", () => {
    const other: Container = {
      ...baseContainer,
      image: "ghcr.io/u7chan/monorepo/portal-admin:latest",
    };

    expect(isPortalContainer(other, "ubuntu-host")).toBe(false);
  });

  test("コンテナ ID と一致する HOSTNAME のコンテナは除外する", () => {
    expect(isPortalContainer(baseContainer, "a1b2c3d4e5f6")).toBe(true);
  });

  test("コンテナ ID 形式でない HOSTNAME では自己判定しない", () => {
    const container: Container = { ...baseContainer, id: "abccompany0001" };

    expect(isPortalContainer(container, "abc")).toBe(false);
  });

  test("空の配列に対しても動作する", () => {
    expect(excludePortalContainers([], "ubuntu-host")).toEqual([]);
  });
});

describe("parseContainerList", () => {
  function rawLine(id: string, name: string, image: string): string {
    return JSON.stringify({
      ID: id,
      Names: `/${name}`,
      Image: image,
      State: "running",
      Status: "Up 1 hour",
      Ports: "",
    });
  }

  test("portal 自身（HOSTNAME がコンテナ ID）は結果に含めない", () => {
    const output = [
      rawLine("abc123def456", "portal", "ghcr.io/u7chan/monorepo/portal:latest"),
      rawLine("def789ghi012", "my-app", "nginx:latest"),
    ].join("\n");

    expect(parseContainerList(output, "abc123def456").map((c) => c.name)).toEqual(["my-app"]);
  });

  test("portal のイメージも結果から除く", () => {
    const output = [
      rawLine("111111111111", "portal", "ghcr.io/u7chan/monorepo/portal@sha256:abc123"),
      rawLine("def789ghi012", "my-app", "nginx:latest"),
    ].join("\n");

    expect(parseContainerList(output, "ubuntu-host").map((c) => c.name)).toEqual(["my-app"]);
  });

  test("ホスト上のプロセスとして動く場合は全て返す", () => {
    const output = [
      rawLine("abc123def456", "my-app", "nginx:latest"),
      rawLine("def789ghi012", "stopped-app", "redis:latest"),
    ].join("\n");

    expect(parseContainerList(output, "ubuntu-host").map((c) => c.name)).toEqual([
      "my-app",
      "stopped-app",
    ]);
  });

  test("壊れた行は無視して残りを返す", () => {
    const output = ["not-json", rawLine("def789ghi012", "my-app", "nginx:latest")].join("\n");

    expect(parseContainerList(output, "ubuntu-host").map((c) => c.name)).toEqual(["my-app"]);
  });

  test("出力が空なら空配列を返す", () => {
    expect(parseContainerList("", "ubuntu-host")).toEqual([]);
  });
});

describe("parseContainer deploy metadata", () => {
  test("monorepo の GHCR イメージと compose project が一致すれば canDeploy", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/usage-portal",
      State: "running",
      Status: "Up",
      Image: "ghcr.io/u7chan/monorepo/usage-portal:sha-abc1234",
      Labels: "com.docker.compose.project=usage-portal",
    };

    const result = parseContainer(raw);

    expect(result.deployTarget).toBe("usage-portal");
    expect(result.canDeploy).toBe(true);
  });

  test("sidecar は canDeploy にしない", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/u7agent-sandbox",
      State: "running",
      Status: "Up",
      Image: "ghcr.io/u7chan/monorepo/u7agent:sha-abc1234",
      Labels: "com.docker.compose.project=u7agent",
    };

    expect(parseContainer(raw).canDeploy).toBe(false);
  });

  test("Docker Hub のイメージは canDeploy にしない", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/caddy",
      State: "running",
      Status: "Up",
      Image: "caddy:2.11.7",
      Labels: "com.docker.compose.project=edge",
    };

    expect(parseContainer(raw).canDeploy).toBe(false);
  });

  test("compose project がなければ canDeploy にしない", () => {
    const raw: DockerContainerRaw = {
      ID: "abc123def456",
      Names: "/usage-portal",
      State: "running",
      Status: "Up",
      Image: "ghcr.io/u7chan/monorepo/usage-portal:sha-abc1234",
      Labels: "com.docker.compose.service=usage-portal",
    };

    expect(parseContainer(raw).canDeploy).toBe(false);
  });
});
