// ports.ts の表示ロジック（ポートタイルの URL と 2 行目）の仕様

import { describe, expect, test } from "bun:test";
import { buildPortUrl, describePort } from "./ports";

describe("buildPortUrl", () => {
  test("ホストと公開ポートから http の URL を組み立てる", () => {
    expect(buildPortUrl("localhost", 3000)).toBe("http://localhost:3000");
  });

  test("ホスト名に PORTAL_HOST の値をそのまま使う", () => {
    expect(buildPortUrl("portal.example.com", 8443)).toBe("http://portal.example.com:8443");
  });

  test("上書き URL があればそれを優先する", () => {
    expect(buildPortUrl("192.0.2.10", 443, "https://portal.home.arpa")).toBe(
      "https://portal.home.arpa",
    );
  });

  test("上書き URL で http を明示できる", () => {
    expect(buildPortUrl("192.0.2.10", 80, "http://portal.home.arpa")).toBe(
      "http://portal.home.arpa",
    );
  });

  test("上書き URL がないポートは PORTAL_HOST とポートに戻る", () => {
    expect(buildPortUrl("192.0.2.10", 5432, undefined)).toBe("http://192.0.2.10:5432");
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
