// サービスの状態表示 (トップバー) の契約。
//   - 表の 5 行の描画 (到達不可 + 実績ありの停止中を含む) とリンクの出し分け
//   - desktop の並び ([状態] [サービス] [停止/起動] | [通知] [作業フォルダ]) と区切り線
//   - compact の状態アイコン (停止中は押せない) と状態の形 (色だけに頼らない)
//   - 置き換えの確認文言と、確認してから実行する順序 (文言は純関数 + ソース走査)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServedAppGroup, ServedAppIndicator } from "../src/components/ServedAppStatus";
import { servedAppReplaceConfirm, servedAppUrl, servedAppView } from "../src/lib/servedApp";
import { serveProps, serveStatus } from "./serve-fixture";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** location.hostname を使うリンク生成のための最小のグローバル (node には無い) */
function withLocation<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "app.test" } });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

test("サービス URL は hostname と health のポートで組み、未取得・不正値には URL を作らない", () => {
  assert.equal(servedAppUrl("localhost", 8080), "http://localhost:8080/");
  assert.equal(servedAppUrl("192.168.1.2", 8016), "http://192.168.1.2:8016/");
  assert.equal(servedAppUrl("[::1]", 8016), "http://[::1]:8016/");
  for (const port of [undefined, 0, -1, 65536, 1.5, NaN]) assert.equal(servedAppUrl("localhost", port), undefined);
});

test("表の 5 行を状態・リンク・操作へ写す", () => {
  // 到達可 + mine: 稼働中 + リンク + 停止
  const running = servedAppView(
    serveStatus({ reachable: true, owner: { kind: "mine", title: "トップページの改修" }, generation: "gen-1" }),
  );
  assert.deepEqual(
    [running.kind, running.label, running.tone, running.canOpen, running.canStop, running.canStart],
    ["running", "稼働中", "ok", true, true, false],
  );
  // 到達可 + other + 実績: 停止中 (リンクなし) + 起動 (置き換え)
  const other = servedAppView(serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }));
  assert.deepEqual(
    [other.kind, other.label, other.tone, other.canOpen, other.canStop, other.canStart, other.ownerTitle],
    ["other", "停止中", "idle", false, false, true, "決済画面の検証"],
  );
  // 到達可 + unknown + 実績: 停止中（起動元不明）+ 停止 + 起動
  const unknown = servedAppView(serveStatus({ reachable: true, owner: { kind: "unknown" } }));
  assert.deepEqual(
    [unknown.kind, unknown.label, unknown.tone, unknown.canOpen, unknown.canStop, unknown.canStart],
    ["unknown", "停止中（起動元不明）", "warn", false, true, true],
  );
  // 到達不可 + 実績: 停止中 + 起動
  const stopped = servedAppView(serveStatus());
  assert.deepEqual(
    [stopped.kind, stopped.label, stopped.tone, stopped.canOpen, stopped.canStop, stopped.canStart],
    ["stopped", "停止中", "idle", false, false, true],
  );
  // 実績なし (および取得失敗) は何も出さない
  for (const status of [serveStatus({ command: null }), null, undefined]) {
    assert.equal(servedAppView(status).kind, "none");
  }
  // 到達可でも実績が無ければ何も出さない (他会話の実績は見せない)
  assert.equal(servedAppView(serveStatus({ reachable: true, command: null })).kind, "none");
});

test("desktop は [状態] [サービス] [停止/起動] を順に出し、リンクは稼働中だけ", () => {
  const html = withLocation(() =>
    renderToStaticMarkup(
      createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) })),
    ),
  );
  assert.match(html, /稼働中/);
  assert.match(html, /href="http:\/\/app.test:8016\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /aria-label="サービスを開く"/);
  assert.match(html, /サービス<\/a>/);
  assert.match(html, /停止/);
  assert.ok(!html.includes("起動</button>"));
  // 並びは 状態 → サービス → 停止 → 区切り
  assert.ok(html.indexOf("稼働中") < html.indexOf("サービス</a>"));
  assert.ok(html.indexOf("サービス</a>") < html.indexOf("停止"));

  // 停止中 (実績あり) はリンクを出さない
  const stopped = withLocation(() => renderToStaticMarkup(createElement(ServedAppGroup, serveProps())));
  assert.ok(!stopped.includes("href="));
  assert.match(stopped, /停止中/);
  assert.match(stopped, /起動/);

  // 起動元不明は停止と起動の両方
  const unknown = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppGroup,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) }),
      ),
    ),
  );
  assert.match(unknown, /停止中（起動元不明）/);
  assert.ok(unknown.includes("停止") && unknown.includes("起動"));

  // 実績なし・取得失敗は何も出さない
  for (const props of [serveProps({ status: null }), serveProps({ failed: true })]) {
    assert.equal(renderToStaticMarkup(createElement(ServedAppGroup, props)), "");
  }
});

test("起動中は遷移状態としてバッジとキャンセルを出し、状態の形で区別する", () => {
  const html = renderToStaticMarkup(
    createElement(ServedAppGroup, serveProps({ status: null, starting: true, failed: false })),
  );
  assert.match(html, /起動中…/);
  assert.match(html, /キャンセル/);
  // 色だけでなく形でも区別する (稼働中 = 塗りドット / 起動元不明 = ! / 起動中 = スピナー)
  assert.match(html, /run-spinner/);
  const unknown = renderToStaticMarkup(
    createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) })),
  );
  assert.match(unknown, />!<\/span>/);
  const running = withLocation(() =>
    renderToStaticMarkup(
      createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) })),
    ),
  );
  assert.match(running, /dot dot-ok/);
});

test("compact は状態アイコン 1 個。停止中は押せない状態表示でメニューも出さない", () => {
  const running = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppIndicator,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) }),
      ),
    ),
  );
  assert.match(running, /aria-label="サービスは稼働中。メニューを開く"/);
  assert.match(running, /aria-haspopup="menu"/);
  assert.match(running, /popover="auto"/);
  assert.match(running, /role="menu"/);
  assert.match(running, /サービスを開く/);
  assert.match(running, /停止/);

  // 停止中は role="img" の押せない状態表示 (ボタンもメニューも出さない)
  const stopped = renderToStaticMarkup(createElement(ServedAppIndicator, serveProps()));
  assert.match(stopped, /role="img" aria-label="サービスは停止中"/);
  assert.match(stopped, /serve-indicator/);
  assert.ok(!stopped.includes("<button"));
  assert.ok(!stopped.includes("popover"));

  // 他会話が使用中は押せて、起動は説明文で置き換えを予告する
  const other = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppIndicator,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }) }),
      ),
    ),
  );
  assert.match(other, /aria-label="サービスは停止中。メニューを開く"/);
  assert.match(other, /会話「決済画面の検証」が公開中/);
  assert.match(other, /会話「決済画面の検証」を停止して置き換え/);

  // 起動元不明は停止も選べる
  const unknown = renderToStaticMarkup(
    createElement(
      ServedAppIndicator,
      serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) }),
    ),
  );
  assert.match(unknown, /停止中（起動元不明）/);
  assert.match(unknown, /記録と一致しないプロセスが使用中/);
  assert.match(unknown, /いま公開中のプロセスを停止/);
  assert.match(unknown, /停止して置き換え/);

  // 実績なし・取得失敗はアイコン自体を出さない
  for (const props of [serveProps({ status: null }), serveProps({ failed: true })]) {
    assert.equal(renderToStaticMarkup(createElement(ServedAppIndicator, props)), "");
  }
});

test("desktop の停止は常時表示にする (ホバー待ちにしない)", () => {
  const source = read("src/components/ServedAppStatus.tsx");
  const group = source.slice(source.indexOf("export function ServedAppGroup"));
  assert.match(group, /view\.canStop \? \(/, "停止は状態の条件だけで出し分ける");
  for (const hidden of ["group-hover:", "opacity-0", "invisible"]) {
    assert.ok(!group.includes(hidden), `停止をホバー待ちにしない: ${hidden}`);
  }
});

test("置き換えの確認文言は所有者名と起動コマンドを出す", () => {
  const other = servedAppView(serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }));
  assert.equal(
    servedAppReplaceConfirm(other),
    [
      "「決済画面の検証」のサービスが公開中です。同時に 1 つしか公開できないため、停止して置き換えます。",
      "停止するのは会話「決済画面の検証」のサーバーです。この会話の起動コマンドは pnpm dev です。",
    ].join("\n"),
  );
  const unknown = servedAppView(serveStatus({ reachable: true, owner: { kind: "unknown" } }));
  assert.match(servedAppReplaceConfirm(unknown), /起動元不明のサービスが公開中です/);
  assert.match(servedAppReplaceConfirm(unknown), /pnpm dev/);
});

test("置き換えは確認してから実行し、取り消したら実行しない (実行順序をソースで固定)", () => {
  const source = read("src/components/ServedAppStatus.tsx");
  // 起動の項目は説明文で予告し、押した後に確認を出す。確認が false なら onStart を呼ばない
  const start = source.slice(source.indexOf("...(view.canStart"), source.indexOf("...(view.canStart") + 400);
  assert.match(start, /label: "起動"/);
  assert.match(start, /description: servedAppReplaceHint\(view\)/);
  const group = source.slice(source.indexOf("export function ServedAppGroup"));
  assert.match(group, /onClick=\{onStart\}/, "desktop の起動は確認なしで直接実行しない");
  // desktop の起動ボタンは App 側で確認を挟む (バーはハンドラを受け取るだけ)
  const app = read("src/App.tsx");
  const handler = app.slice(app.indexOf("const handleServeStart"), app.indexOf("const handleServeStart") + 900);
  assert.match(handler, /servedAppReplaceConfirm\(/);
  assert.match(handler, /!window\.confirm\(/);
  const confirmIndex = handler.indexOf("window.confirm");
  const startIndex = handler.indexOf("serve.start");
  assert.ok(confirmIndex !== -1 && startIndex > confirmIndex, "確認の後に実行する");
  // 取り消しでは実行しない (早期 return)
  assert.ok(handler.indexOf("return;") > confirmIndex && handler.indexOf("return;") < startIndex);
});

test("両バーに serve の状態を渡し、client に既定ポートを焼き込まない", () => {
  const app = read("src/App.tsx");
  assert.equal(app.match(/serve=\{serveProps\}/g)?.length, 2);
  assert.match(app, /port: app\.health\?\.previewPort/);
  for (const bar of ["Topbar", "CompactBar"]) {
    const source = read(`src/components/${bar}.tsx`);
    assert.match(source, /serve(\.|:)/);
  }
  const source = read("src/components/ServedAppStatus.tsx");
  // 待受ポート (サーバー側の 8080) をリンクに焼き込まない。URL は health のポートと hostname で組む
  assert.match(source, /servedAppUrl\(location\.hostname, port\)/);
  assert.ok(!source.includes("http://"), "URL を組み立てて焼き込まない");
  assert.ok(!source.includes("window.open"));
  // リンクは必ず <a> か、document に繋いだ anchor の click で開く
  assert.match(read("src/lib/servedApp.ts"), /anchor\.target = "_blank"/);
});
