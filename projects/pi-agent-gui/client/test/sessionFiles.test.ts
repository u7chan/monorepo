// チャットの右パネル (セッションのファイル) の規則を固定する。出し分けが崩れると
// compact や設定ページにパネルが残り、run 終了の判定が崩れると実行中に取得が走るか、
// 書き込み後の一覧が更新されない。
import assert from "node:assert/strict";
import test from "node:test";
import { isRunEnd, sessionFilesRoot } from "../src/lib/sessionFiles";

const cwd = ".pi-agent-gui/sessions/01a0b4cf";

test("パネルは desktop のチャット画面でだけ root を返す", () => {
  assert.equal(sessionFilesRoot({ desktop: true, chatView: true, cwd }), cwd);
  assert.equal(sessionFilesRoot({ desktop: false, chatView: true, cwd }), "", "compact では出さない");
  assert.equal(sessionFilesRoot({ desktop: true, chatView: false, cwd }), "", "設定ページでは出さない");
});

test("セッションが無い (cwd が空) ときは出さない", () => {
  assert.equal(sessionFilesRoot({ desktop: true, chatView: true, cwd: "" }), "");
});

test("run_end は running から抜けた遷移だけ", () => {
  assert.equal(isRunEnd("running", "idle"), true);
  assert.equal(isRunEnd("running", "queued"), true, "次のメッセージが待機していても run は終わっている");
  assert.equal(isRunEnd("running", "error"), true);
  assert.equal(isRunEnd("running", "stopped"), true);
  assert.equal(isRunEnd("running", "running"), false);
  assert.equal(isRunEnd("idle", "running"), false);
  assert.equal(isRunEnd("idle", "idle"), false, "mount 直後 (同じ値) では撃たない");
});
