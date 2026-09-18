// チャットの右パネル (セッションのファイル) の出し分けを固定する。ここが崩れると compact や
// 設定ページにパネルが残る (run_end での取り直しは client/test/chatReducer.test.ts が見る)。
import assert from "node:assert/strict";
import test from "node:test";
import { sessionFilesRoot } from "../src/lib/sessionFiles";

const cwd = ".pi-agent-gui/sessions/01a0b4cf";

test("パネルは desktop のチャット画面でだけ root を返す", () => {
  assert.equal(sessionFilesRoot({ desktop: true, chatView: true, cwd }), cwd);
  assert.equal(sessionFilesRoot({ desktop: false, chatView: true, cwd }), "", "compact では出さない");
  assert.equal(sessionFilesRoot({ desktop: true, chatView: false, cwd }), "", "設定ページでは出さない");
});

test("セッションが無い (cwd が空) ときは出さない", () => {
  assert.equal(sessionFilesRoot({ desktop: true, chatView: true, cwd: "" }), "");
});
