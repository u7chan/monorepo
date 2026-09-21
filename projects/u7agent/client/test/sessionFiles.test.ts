// セッションのファイルを出せる条件を固定する。表示方法は desktop=右パネル / compact=全画面シートだが、
// root の可用性は layout に依存させない (run_end での取り直しは client/test/chatReducer.test.ts が見る)。
import assert from "node:assert/strict";
import test from "node:test";
import { sessionFilesRoot } from "../src/lib/sessionFiles";

const cwd = ".u7agent/sessions/01a0b4cf";

test("チャット画面では選択中セッションの root を返す", () => {
  assert.equal(sessionFilesRoot({ chatView: true, cwd }), cwd);
});

test("設定ページとセッション未作成時は出さない", () => {
  assert.equal(sessionFilesRoot({ chatView: false, cwd }), "", "設定ページでは出さない");
  assert.equal(sessionFilesRoot({ chatView: true, cwd: "" }), "", "cwd が無ければ出さない");
});
