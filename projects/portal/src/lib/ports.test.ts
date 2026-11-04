// ports.ts の表示ロジック（ポートタイルの URL と 2 行目）の仕様

import { describe, expect, test } from "bun:test";
import { buildPortUrl, describePort, describeUrl, isHttpsUrl, orderLinks } from "./ports";

describe("buildPortUrl", () => {
  test("ホストと公開ポートから http の URL を組み立てる", () => {
    expect(buildPortUrl("localhost", 3000)).toBe("http://localhost:3000");
  });

  test("ホスト名に PORTAL_HOST の値をそのまま使う", () => {
    expect(buildPortUrl("portal.example.com", 8443)).toBe("http://portal.example.com:8443");
  });

  test("公開ポートはそのまま URL のポートになる", () => {
    expect(buildPortUrl("192.0.2.10", 5432)).toBe("http://192.0.2.10:5432");
  });
});

describe("describePort", () => {
  test("公開ポートと内部ポートが同じならプロトコルだけを返す", () => {
    expect(
      describePort({ host: "0.0.0.0", publicPort: 80, privatePort: 80, protocol: "tcp" }),
    ).toBe("tcp");
  });

  test("公開ポートと内部ポートが違えば対応関係を返す", () => {
    expect(
      describePort({ host: "0.0.0.0", publicPort: 8010, privatePort: 3000, protocol: "tcp" }),
    ).toBe("3000/tcp");
  });

  test("udp など tcp 以外のプロトコルもそのまま出す", () => {
    expect(
      describePort({ host: "0.0.0.0", publicPort: 53, privatePort: 53, protocol: "udp" }),
    ).toBe("udp");
  });
});

describe("describeUrl", () => {
  test("URL のホスト名だけを返す（ポート番号は行き先を表さない）", () => {
    expect(describeUrl("https://dozzle.home.arpa/")).toBe("dozzle.home.arpa");
    expect(describeUrl("https://agent.home.arpa:8443/path")).toBe("agent.home.arpa:8443");
  });

  test("URL として読めない値はそのまま返す", () => {
    expect(describeUrl("not a url")).toBe("not a url");
  });
});

describe("isHttpsUrl", () => {
  test("https のときだけ true", () => {
    expect(isHttpsUrl("https://dozzle.home.arpa")).toBe(true);
    expect(isHttpsUrl("http://dozzle.home.arpa")).toBe(false);
  });

  test("URL として読めない値は false", () => {
    expect(isHttpsUrl("dozzle.home.arpa")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });
});

describe("orderLinks", () => {
  const port = (publicPort: number) => ({
    host: "0.0.0.0",
    publicPort,
    privatePort: publicPort,
    protocol: "tcp",
  });

  test("公開ポートを番号の昇順に並べる", () => {
    expect(orderLinks([port(443), port(80)], undefined).map((link) => link.portNumber)).toEqual([
      80, 443,
    ]);
  });

  test("公開をやめた上書きも番号の昇順に混ぜる", () => {
    const links = orderLinks([port(4318), port(4319)], {
      4317: "https://agent.home.arpa",
      4319: "https://service.agent.home.arpa",
    });

    expect(links.map((link) => [link.portNumber, link.url])).toEqual([
      [4317, "https://agent.home.arpa"],
      [4318, undefined],
      [4319, "https://service.agent.home.arpa"],
    ]);
  });

  test("公開ポートの上書きは同じスロットに載せ、二重に出さない", () => {
    const links = orderLinks([port(8888)], { 8888: "https://dozzle.home.arpa" });

    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://dozzle.home.arpa");
    expect(links[0]?.port?.publicPort).toBe(8888);
  });

  test("ポートも上書きもなければ空", () => {
    expect(orderLinks([], undefined)).toEqual([]);
    expect(orderLinks([], {})).toEqual([]);
  });
});
