import { describe, expect, test } from "bun:test";
import { parseComposeProject, parseLinkLabels } from "./dockerLabels";

describe("parseLinkLabels", () => {
  test("portal.url を単一の入口として読む", () => {
    expect(parseLinkLabels("portal.url=https://dozzle.home.arpa")).toEqual({
      url: "https://dozzle.home.arpa",
    });
  });

  test("portal.hidden=true を読む", () => {
    // docker ps の Labels は YAML のクォートを含まない。
    expect(parseLinkLabels("portal.hidden=true")).toEqual({ hidden: true });
  });

  test("portal.hidden の値が true 以外なら hidden にしない", () => {
    expect(parseLinkLabels("portal.hidden=false")).toEqual({});
    expect(parseLinkLabels("portal.hidden=1")).toEqual({});
  });

  test("portal.url と portal.url.<ポート> を同時に読む", () => {
    const labels =
      "portal.url=https://app.home.arpa,portal.url.4317=https://agent.home.arpa,portal.hidden=false";

    expect(parseLinkLabels(labels)).toEqual({
      url: "https://app.home.arpa",
      urls: { 4317: "https://agent.home.arpa" },
    });
  });

  test("空の portal.url は無視する", () => {
    expect(parseLinkLabels("portal.url=,portal.url.443=")).toEqual({});
  });

  test("portal.url の値に = が含まれても URL 全体を使う", () => {
    expect(parseLinkLabels("portal.url=https://app.home.arpa/?a=b")).toEqual({
      url: "https://app.home.arpa/?a=b",
    });
  });

  test("portal.url.<公開ポート> を公開ポート -> URL に変換する", () => {
    const labels = "portal.url.80=http://portal.home.arpa,portal.url.443=https://portal.home.arpa";

    expect(parseLinkLabels(labels).urls).toEqual({
      80: "http://portal.home.arpa",
      443: "https://portal.home.arpa",
    });
  });

  test("portal.url 以外のラベルは無視する", () => {
    const labels =
      "com.docker.compose.service=caddy,caddy=portal.home.arpa,portal.url.443=https://portal.home.arpa";

    expect(parseLinkLabels(labels).urls).toEqual({ 443: "https://portal.home.arpa" });
  });

  test("ラベルがない場合は urls も url も undefined", () => {
    expect(parseLinkLabels(undefined)).toEqual({});
    expect(parseLinkLabels("")).toEqual({});
    expect(parseLinkLabels("com.docker.compose.service=caddy")).toEqual({});
  });

  test("不正なポートや空の URL は無視する", () => {
    const labels =
      "portal.url.abc=https://portal.home.arpa,portal.url.=https://portal.home.arpa,portal.url.0=https://portal.home.arpa,portal.url.65536=https://portal.home.arpa,portal.url.443=";

    expect(parseLinkLabels(labels)).toEqual({});
  });

  test("不正なラベルがあっても有効なラベルは残す", () => {
    const labels = "portal.url.abc=https://ignored.example,portal.url.443=https://portal.home.arpa";

    expect(parseLinkLabels(labels).urls).toEqual({ 443: "https://portal.home.arpa" });
  });

  test("値に = が含まれても URL 全体を使う", () => {
    expect(parseLinkLabels("portal.url.80=http://portal.home.arpa/?a=b").urls).toEqual({
      80: "http://portal.home.arpa/?a=b",
    });
  });

  test("キーと値の前後の空白を無視する", () => {
    expect(parseLinkLabels(" portal.url.443 = https://portal.home.arpa ").urls).toEqual({
      443: "https://portal.home.arpa",
    });
  });
});

describe("parseComposeProject", () => {
  test("compose project ラベルを読む", () => {
    expect(
      parseComposeProject("com.docker.compose.service=portal,com.docker.compose.project=portal"),
    ).toBe("portal");
  });

  test("キーと値の前後の空白を無視する", () => {
    expect(parseComposeProject(" com.docker.compose.project = usage-portal ")).toBe("usage-portal");
  });

  test("ラベルがなければ undefined", () => {
    expect(parseComposeProject(undefined)).toBeUndefined();
    expect(parseComposeProject("")).toBeUndefined();
    expect(parseComposeProject("com.docker.compose.service=portal")).toBeUndefined();
  });

  test("値が空なら undefined", () => {
    expect(parseComposeProject("com.docker.compose.project=")).toBeUndefined();
  });
});
