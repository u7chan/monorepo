// Git の identity の値の規則と、サンドボックスへ書く INI の組み立て。API / DB は触らない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_USER_EMAIL_MAX_LENGTH,
  GIT_USER_NAME_MAX_LENGTH,
  gitConfigQuotedValue,
  gitConfigText,
  gitIdentityProblem,
} from "../src/git-identity";
const VALID = { userName: "u7chan", userEmail: "u7chan@example.com" };

test("前後の空白を落とした両方の値だけを受け付ける", () => {
  assert.equal(gitIdentityProblem(VALID), undefined);
  assert.equal(gitIdentityProblem({ userName: "  u7chan  ", userEmail: "  u7chan@example.com  " }), undefined);
  assert.match(gitIdentityProblem({ userName: "", userEmail: VALID.userEmail }) ?? "", /名前/);
  assert.match(gitIdentityProblem({ userName: "   ", userEmail: VALID.userEmail }) ?? "", /名前/);
  assert.match(gitIdentityProblem({ userName: VALID.userName, userEmail: "" }) ?? "", /メールアドレス/);
  assert.match(gitIdentityProblem({ userName: VALID.userName, userEmail: "no-at-mark" }) ?? "", /形式/);
  assert.match(gitIdentityProblem({ userName: VALID.userName, userEmail: "a@b" }) ?? "", /形式/);
});

test("制御文字・改行・NUL・< > と上限超過を拒否する", () => {
  for (const userName of ["a\nb", "a\tb", "a\u0000b", "a<b", "a>b"]) {
    assert.ok(gitIdentityProblem({ userName, userEmail: VALID.userEmail }), `${userName} を通した`);
  }
  for (const userEmail of ["a\n@example.com", "a\u0000@example.com", "a@example.com<b", "a@exa<mple.com>"]) {
    assert.ok(gitIdentityProblem({ userName: VALID.userName, userEmail }), `${userEmail} を通した`);
  }
  assert.ok(gitIdentityProblem({ userName: "a".repeat(GIT_USER_NAME_MAX_LENGTH + 1), userEmail: VALID.userEmail }));
  assert.ok(
    gitIdentityProblem({
      userName: VALID.userName,
      userEmail: `${"a".repeat(GIT_USER_EMAIL_MAX_LENGTH)}@example.com`,
    }),
  );
});

test("INI は値を quote し、未設定でも useConfigOnly だけを書く", () => {
  const text = gitConfigText({ userName: 'a "quoted" \\ name', userEmail: "u@example.com" });
  assert.match(text, /^\[user\]\n/);
  assert.match(text, /name = "a \\"quoted\\" \\\\ name"/);
  assert.match(text, /email = "u@example\.com"/);
  assert.match(text, /useConfigOnly = true/);
  assert.equal(gitConfigText(null), "[user]\n\tuseConfigOnly = true\n");
  assert.equal(gitConfigQuotedValue('x"y'), '"x\\"y"');
});
