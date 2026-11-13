// 設定 → Git の入力規則と保存可否、予約名の注記。保存の正はサーバー側で、ここは往復を減らす写し。
import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_USER_EMAIL_MAX_LENGTH,
  GIT_USER_NAME_MAX_LENGTH,
  gitIdentityCanSave,
  gitIdentityInputProblem,
} from "../src/lib/gitSettings";
import { ENV_IGNORED_BY_GIT_NOTE } from "../src/lib/sessionEnv";

const VALID = { userName: "u7chan", userEmail: "u7chan@example.com" };

test("前後の空白だけの入力と片方だけの入力を拒否する", () => {
  assert.equal(gitIdentityInputProblem(VALID.userName, VALID.userEmail), undefined);
  assert.equal(gitIdentityInputProblem("  u7chan  ", "  u7chan@example.com  "), undefined);
  assert.match(gitIdentityInputProblem("   ", VALID.userEmail) ?? "", /名前/);
  assert.match(gitIdentityInputProblem(VALID.userName, "") ?? "", /メールアドレス/);
  assert.match(gitIdentityInputProblem(VALID.userName, "no-at-mark") ?? "", /形式/);
});

test("制御文字・改行・NUL・< > と上限超過を拒否する", () => {
  for (const userName of ["a\nb", "a\tb", "a\u0000b", "a<b", "a>b"]) {
    assert.ok(gitIdentityInputProblem(userName, VALID.userEmail), `${userName} を通した`);
  }
  for (const userEmail of ["a\n@example.com", "a\u0000@example.com", "a@example.com<b", "a@exa<mple.com>"]) {
    assert.ok(gitIdentityInputProblem(VALID.userName, userEmail), `${userEmail} を通した`);
  }
  assert.ok(gitIdentityInputProblem("a".repeat(GIT_USER_NAME_MAX_LENGTH + 1), VALID.userEmail));
  assert.ok(gitIdentityInputProblem(VALID.userName, `${"a".repeat(GIT_USER_EMAIL_MAX_LENGTH)}@example.com`));
});

test("無変更では保存させず、保存中も保存させない", () => {
  const saved = { userName: "u7chan", userEmail: "u7chan@example.com" };
  assert.equal(gitIdentityCanSave({ userName: "u7chan", userEmail: "u7chan@example.com" }, saved, false), false);
  assert.equal(gitIdentityCanSave({ userName: "other", userEmail: "u7chan@example.com" }, saved, false), true);
  assert.equal(gitIdentityCanSave({ userName: "other", userEmail: "u7chan@example.com" }, saved, true), false);
  assert.equal(gitIdentityCanSave({ userName: "other", userEmail: "" }, saved, false), false);
  assert.equal(
    gitIdentityCanSave({ userName: "other", userEmail: "o@example.com" }, { userName: null, userEmail: null }, false),
    true,
  );
  assert.match(ENV_IGNORED_BY_GIT_NOTE, /予約名/);
});
