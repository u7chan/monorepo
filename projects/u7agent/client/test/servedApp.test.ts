import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServedAppLink } from "../src/components/ServedAppLink";
import { servedAppUrl } from "../src/lib/servedApp";

test("serve URL は hostname と health のポートで組み、未取得・不正値には URL を作らない", () => {
  assert.equal(servedAppUrl("localhost", 8080), "http://localhost:8080/");
  assert.equal(servedAppUrl("192.168.1.2", 8016), "http://192.168.1.2:8016/");
  assert.equal(servedAppUrl("[::1]", 8016), "http://[::1]:8016/");
  for (const port of [undefined, 0, -1, 65536, 1.5, NaN]) assert.equal(servedAppUrl("localhost", port), undefined);
});

test("未取得は無効、取得後は別タブのリンクで compact はアイコンだけにする", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "app.test" } });
  try {
    const disabled = renderToStaticMarkup(createElement(ServedAppLink, {}));
    assert.match(disabled, /<button[^>]*disabled=""/);
    assert.ok(!disabled.includes("href="));
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(createElement(ServedAppLink, { port: 8016, compact }));
      assert.match(html, /href="http:\/\/app.test:8016\/"/);
      assert.match(html, /target="_blank"/);
      assert.match(html, /rel="noreferrer noopener"/);
      assert.match(html, /aria-label="serveした成果物を開く"/);
      assert.equal(html.includes("成果物</a>"), !compact);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("両バーに health の previewPort を渡し、client に既定ポートを焼き込まない", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.equal(app.match(/previewPort=\{app\.health\?\.previewPort\}/g)?.length, 2);
  for (const bar of ["Topbar", "CompactBar"]) {
    const source = readFileSync(new URL(`../src/components/${bar}.tsx`, import.meta.url), "utf8");
    assert.match(source, /<ServedAppLink port=\{previewPort\}/);
  }
  const source = readFileSync(new URL("../src/components/ServedAppLink.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("8080"));
  assert.ok(!source.includes("window.open"));
});
