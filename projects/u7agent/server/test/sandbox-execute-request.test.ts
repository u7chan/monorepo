import assert from "node:assert/strict";
import test from "node:test";
import { parseExecuteRequest } from "../src/sandbox/execute-request";

test("missing execution settings stay unspecified and cwd defaults to the workspace", () => {
  const expected = {
    toolCallId: undefined,
    params: undefined,
    requestedCwd: "",
    injected: undefined,
    requestedGitConfig: undefined,
    requestedScope: undefined,
    networkAccess: undefined,
  };
  for (const body of [undefined, null, {}, { env: {} }, [], "ignored"]) {
    assert.deepEqual(parseExecuteRequest(body), expected);
  }
});

test("explicit identity removal, an empty write scope, and denied network access are not omissions", () => {
  assert.deepEqual(
    parseExecuteRequest({
      toolCallId: 42,
      params: { path: "note.md" },
      cwd: "notes",
      env: { APP_SETTING: " value " },
      gitConfig: null,
      writeScope: [],
      networkAccess: false,
    }),
    {
      toolCallId: 42,
      params: { path: "note.md" },
      requestedCwd: "notes",
      injected: { APP_SETTING: " value " },
      requestedGitConfig: null,
      requestedScope: [],
      networkAccess: false,
    },
  );
});

test("execution input keeps legacy Git env rows and normalizes the requested identity and scope", () => {
  const request = parseExecuteRequest({
    env: { GIT_AUTHOR_NAME: "Saved Author" },
    gitConfig: { userName: " New Author ", userEmail: " author@example.com " },
    writeScope: [
      { path: "notes", create: false },
      { path: "output", create: true },
    ],
    networkAccess: true,
  });
  assert.deepEqual(request.injected, { GIT_AUTHOR_NAME: "Saved Author" });
  assert.deepEqual(request.requestedGitConfig, { userName: "New Author", userEmail: "author@example.com" });
  assert.deepEqual(request.requestedScope, [{ path: "notes" }, { path: "output", create: true }]);
  assert.equal(request.networkAccess, true);
});

test("invalid execution fields are reported in request validation order", () => {
  const invalid = {
    params: [],
    cwd: null,
    networkAccess: null,
    env: [],
    gitConfig: "invalid",
    writeScope: {},
  };
  const failures = [
    ["params", "params must be an object"],
    ["cwd", "cwd must be a string"],
    ["networkAccess", "networkAccess must be a boolean"],
    ["env", "env must be an object"],
    ["gitConfig", "gitConfig must be an object or null"],
    ["writeScope", "writeScope must be an array"],
  ] as const;
  const body: Partial<typeof invalid> = { ...invalid };
  for (const [field, message] of failures) {
    assert.throws(() => parseExecuteRequest(body), { message });
    delete body[field];
  }
});
