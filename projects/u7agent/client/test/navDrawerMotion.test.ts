// overlay の左バー (NavSheet) を閉じるときの退場アニメの契約を固定する。client に DOM テスト基盤が無く、
// animationend のタイミングは自動では観測できないため、CSS の定義と配線をソース走査で突き合わせ、
// 実際の動きは手動確認に残す (docs/ui-layout.md#サイドバー)。
//   1. 退場アニメが動かない / 切られる / fill が戻ると、animationend が来ずドロワーが閉じられなくなる
//   2. 閉じる要求が dialog.close() を直に呼ぶと、退場アニメが出ないまま消える
//   3. 背景の暗転が unmount まで残ると、閉じ切った瞬間に画面が急に明るくなる
//   4. 選んだ項目 (セッションなど) を閉じる側へ載せ忘れると、その面だけ退場アニメが出ない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** 閉じるときにドロワーを閉じる (退場アニメに載せる) Sidebar の props */
const CLOSE_ON_SELECT_PROPS = ["newChat", "selectSession", "onOpenSettingsSection"] as const;

/** 開いたままにする props。削除とリネームは確認 / 入力の後も連続操作しうる */
const STAY_OPEN_PROPS = ["renameSession", "deleteSession", "deleteProject", "onSelectMode"] as const;

const REDUCE_MOTION = "@media (prefers-reduced-motion: reduce) {";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** `@media (prefers-reduced-motion: reduce)` の中身を波括弧の深さで切り出す */
function reduceMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  let at = css.indexOf(REDUCE_MOTION);
  while (at >= 0) {
    let depth = 0;
    let end = css.length;
    for (let index = at + REDUCE_MOTION.length - 1; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    blocks.push(css.slice(at, end));
    at = css.indexOf(REDUCE_MOTION, end);
  }
  return blocks;
}

/** `@keyframes <name>` の規則を切り出す (定義の中身だけを見る) */
function keyframes(css: string, name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  assert.ok(at >= 0, `@keyframes ${name} が無い`);
  return css.slice(at, at + 200);
}

test("退場アニメは開く側と対称で、閉じるまで 1 フレームも元へ戻らない", () => {
  const css = read("src/styles/index.css");
  const token = (name: string) => {
    const at = css.indexOf(`--animate-${name}:`);
    assert.ok(at >= 0, `--animate-${name} が無い`);
    return css.slice(at, css.indexOf(";", at));
  };
  const duration = (name: string) => token(name).match(/(\d+)ms/)?.[1];
  assert.equal(duration("drawer-out"), duration("drawer"), "開く側と閉じる側で長さが違う");
  // fill が none だと、animationend から dialog が閉じるまでの 1 フレームだけ元の位置と不透明度で描かれる
  assert.ok(token("drawer-out").includes("forwards"), "退場アニメの fill が forwards でない");
  assert.ok(keyframes(css, "drawer-out").includes("translateX(-12px)"), "閉じる側の移動量が開く側と対称でない");
  assert.ok(keyframes(css, "drawer-out").includes("opacity: 0;"), "閉じる側の到達点が透明でない");
});

test("退場アニメは prefers-reduced-motion で切らない (切るとドロワーを閉じられない)", () => {
  const css = read("src/styles/index.css");
  const blocks = reduceMotionBlocks(css);
  assert.ok(blocks.length > 0, "prefers-reduced-motion の規則が 1 つも無い (切り出しに失敗している)");
  for (const block of blocks) {
    assert.ok(
      !block.includes("drawer-out") && !block.includes("animate-drawer"),
      "動きを止める設定で退場アニメを切ると animationend が来ず、ドロワーが閉じられなくなる",
    );
  }
});

test("NavSheet は閉じる要求を 1 経路に寄せ、退場アニメの完了で dialog を閉じる", () => {
  const sheet = read("src/components/NavSheet.tsx");
  assert.ok(sheet.includes("const [closing, setClosing] = useState(false);"), "退場アニメの state が無い");
  assert.ok(sheet.includes("const requestClose = () => setClosing(true);"), "閉じる要求の入口が 1 つでない");
  // パネルは closing で開く側 / 閉じる側の animation を切り替える
  assert.ok(sheet.includes('closing ? "animate-drawer-out" : "animate-drawer"'), "パネルの退場アニメが切り替わらない");
  // 閉じる導線 (× / 背景クリック / Escape / 項目の選択) は全部 requestClose を通る
  assert.ok(sheet.includes("onClose={requestClose}"), "Sidebar の × が退場アニメを通らない");
  assert.ok(
    sheet.includes("if (event.target === dialogRef.current) requestClose();"),
    "背景クリックが退場アニメを通らない",
  );
  assert.ok(sheet.includes("event.preventDefault();"), "Escape が標準挙動で即時に閉じる");
  // 閉じるのは退場アニメの完了後 1 か所だけ (animationend は子の animation からも上がるので自分宛てだけを見る)
  assert.ok(sheet.includes("if (!closing || event.target !== event.currentTarget) return;"), "子の animation で閉じる");
  assert.equal(sheet.split("dialogRef.current?.close();").length - 1, 1, "dialog を閉じる場所が退場アニメ以外にもある");
});

test("ドロワーは選んだら閉じ、削除とリネームでは閉じない", () => {
  const sheet = read("src/components/NavSheet.tsx");
  for (const prop of CLOSE_ON_SELECT_PROPS) {
    assert.ok(sheet.includes(`${prop}={closeThen(sidebarProps.${prop})}`), `${prop} が退場アニメを通らない`);
  }
  for (const prop of STAY_OPEN_PROPS) {
    assert.ok(!sheet.includes(`${prop}={closeThen(`), `${prop} でドロワーを閉じている (開いたまま残す契約)`);
  }
});

test("モーダルを開く New Project は、退場と unmount が済んでから実行する", () => {
  const sheet = read("src/components/NavSheet.tsx");
  // 退場中に開くと、開いたモーダルが戻り先として掴むドロワー内の要素が unmount で消え、閉じた後に
  // focus が body へ落ちる (docs/ui-layout.md の「body へは落とさない」契約が壊れる)
  assert.ok(sheet.includes("onNewProject={closeAfter(sidebarProps.onNewProject)}"), "New Project が退場中に開く");
  assert.ok(!sheet.includes("onNewProject={closeThen("), "New Project を即時に実行している");
  assert.ok(sheet.includes("afterCloseRef.current = after;"), "退場後の操作を保持していない");
  // 実行は dialog の close (App の unmount と同じコミット) で行う。別のコミットで開くと、戻り先の要素が
  // "ドロワーの焦点復帰より前" にならない
  const handler = sheet.slice(sheet.indexOf("onClose={() =>"), sheet.indexOf("tabIndex={-1}"));
  assert.ok(handler.indexOf("onClose();") < handler.indexOf("after?.();"), "unmount と別のコミットで実行している");
  // docked へ戻る経路では App がドロワーを直接 unmount して dialog の close が来ないので、そこで落とさない
  assert.ok(sheet.includes("useEffect(() => () => afterCloseRef.current?.(), []);"), "unmount で待たせた操作が消える");
});

test("App は退場アニメの完了までドロワーを描き続ける", () => {
  const app = read("src/App.tsx");
  assert.ok(app.includes("{navOpen && !sidebarDocked ? <NavSheet {...navProps} onClose={closeNav} /> : null}"));
  // 閉じる要求を App が持つと、animationend を待たずに unmount されて退場アニメが出ない
  assert.ok(!app.includes("drawerProps"), "App が閉じる要求 (drawerProps) を持っている");
  assert.ok(!app.includes("closeNav();"), "退場アニメを通らない閉じ方がある");
  // docked へ戻る経路だけはレイアウトが入れ替わるので、退場アニメ無しで即時に閉じる
  assert.ok(app.includes("if (sidebarDocked) setNavOpen(false);"));
});

test("閉じるときは背景の暗転も一緒に薄くする", () => {
  const css = read("src/styles/index.css");
  const base = css.indexOf(".nav-sheet::backdrop {");
  const closing = css.indexOf('.nav-sheet[data-closing="true"]::backdrop {');
  assert.ok(base >= 0, ".nav-sheet::backdrop の規則が無い");
  assert.ok(closing > base, "退場中に暗転を薄くする規則が無い");
  assert.ok(css.slice(base, css.indexOf("}", base)).includes("transition: opacity"), "暗転が遷移しない");
  assert.ok(css.slice(closing, css.indexOf("}", closing)).includes("opacity: 0;"), "退場中も暗転が濃いままになる");
  assert.ok(read("src/components/NavSheet.tsx").includes("data-closing={closing}"), "dialog に印が付かない");
});
