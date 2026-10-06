// GET /v1/files/git と readWorkspaceGitInfo。repo はテスト自身が git で作り、listen せず app.request() で検証する。
// git が無い環境では skip する (配布イメージには入っている前提は docs/sandbox-api.md を参照)。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIT_INFO_TIMEOUT_MS, readWorkspaceGitInfo } from "../src/sandbox/git-info";
import type { SandboxGitInfo } from "../src/sandbox/protocol";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";
const HAS_GIT = (() => {
  const probe = spawnSync("git", ["--version"], { stdio: "pipe" });
  return !probe.error && probe.status === 0;
})();
const GIT_SKIP_REASON = "git is not available";

/** コミットに要る識別子は環境変数で渡し、テストの ~/.gitconfig に依存させない */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  assert.equal(result.status, 0, result.stderr?.toString() ?? "");
  return result.stdout.toString();
}

/** コミットを 1 つ持つ repo。branch は HEAD のブランチ名 */
async function createRepo(branch: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-git-"));
  git(root, "init", "-q", "-b", branch);
  await writeFile(join(root, "a.txt"), "hello\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

/** 期限まで答えない偽 git。実 git の終了と期限の競争をテストに持ち込まない */
async function createSlowGit(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sbx-slowgit-"));
  const file = join(dir, "slow-git");
  await writeFile(file, "#!/bin/sh\nsleep 5\nprintf 'main\\n'\n");
  await chmod(file, 0o755);
  return file;
}

async function fetchGit(
  app: ReturnType<typeof createSandboxService>["app"],
  path: string,
): Promise<{ status: number; body: SandboxGitInfo | { error: string } }> {
  const response = await app.request(`/v1/files/git?path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: response.status, body: (await response.json()) as SandboxGitInfo | { error: string } };
}

test(
  "GET /v1/files/git returns the branch of the requested directory",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    const root = await createRepo("feature/x");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      const response = await service.app.request("/v1/files/git?path=.", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { branch: "feature/x" });
    } finally {
      service.close();
    }
  },
);

test(
  "GET /v1/files/git resolves a subdirectory (repo は親で見つかる)",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    const root = await createRepo("main");
    await mkdir(join(root, "src"));
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      const { status, body } = await fetchGit(service.app, "src");
      assert.equal(status, 200);
      assert.deepEqual(body, { branch: "main" });
    } finally {
      service.close();
    }
  },
);

test("GET /v1/files/git returns null outside a repo", { skip: !HAS_GIT && GIT_SKIP_REASON }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-norepo-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const { status, body } = await fetchGit(service.app, ".");
    assert.equal(status, 200, "repo の外はエラーにしない (UI はチップを出さないだけ)");
    assert.deepEqual(body, { branch: null });
  } finally {
    service.close();
  }
});

test(
  "GET /v1/files/git rejects paths outside the workspace and missing paths",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    const root = await createRepo("main");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      assert.equal((await fetchGit(service.app, "..")).status, 400);
      assert.equal((await fetchGit(service.app, "nope")).status, 404);
      // ファイルは一覧と同じく 400 (ディレクトリ以外は受け付けない)
      assert.equal((await fetchGit(service.app, "a.txt")).status, 400);
    } finally {
      service.close();
    }
  },
);

test(
  "GET /v1/files/git gives up within the deadline without failing",
  { skip: (!HAS_GIT && GIT_SKIP_REASON) || (process.platform === "win32" && "sh is not available") },
  async () => {
    // 期限まで答えない偽 git を差し替えて競争を無くす (差し替えが外れると実 git が branch を返して落ちる)
    const root = await createRepo("main");
    const service = createSandboxService({
      token: TOKEN,
      rootCwd: root,
      gitInfoTimeoutMs: 200,
      gitPath: await createSlowGit(),
    });
    try {
      const { status, body } = await fetchGit(service.app, ".");
      assert.equal(status, 200, "期限超過もエラーにせず branch: null にする");
      assert.deepEqual(body, { branch: null });
    } finally {
      service.close();
    }
  },
);

test("readWorkspaceGitInfo returns null when git is missing", async () => {
  const info = await readWorkspaceGitInfo(await mkdtemp(join(tmpdir(), "pi-sbx-nogit-")), {
    pathDirs: [join(tmpdir(), "pi-sbx-empty-path")],
  });
  assert.deepEqual(info, { branch: null });
});

test(
  "readWorkspaceGitInfo drops answers that miss the deadline",
  { skip: process.platform === "win32" && "sh is not available" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sbx-slowgit-"));
    const started = Date.now();
    const info = await readWorkspaceGitInfo(dir, { gitPath: await createSlowGit(), timeoutMs: 200 });
    assert.deepEqual(info, { branch: null }, "期限を過ぎた git は branch: null にする");
    assert.ok(Date.now() - started < GIT_INFO_TIMEOUT_MS, "テストの期限 (200ms) で打ち切る");
  },
);

test(
  "readWorkspaceGitInfo ignores warnings on stderr",
  { skip: process.platform === "win32" && "sh is not available" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sbx-warn-git-"));
    const noisy = join(dir, "noisy-git");
    // 実 git は `core.fsyncObjectFiles` 非推奨の警告を終了コード 0 で stderr へ出し、stdout にブランチ名を出す。
    // 警告の方が先に届くよう、stderr を書いてから間を置く (ストリームの到着順に依存させない)
    await writeFile(
      noisy,
      `#!/bin/sh\nprintf 'warning: core.fsyncObjectFiles is deprecated\\n' >&2\nsleep 0.2\nprintf 'feature/review\\n'\n`,
    );
    await chmod(noisy, 0o755);
    assert.deepEqual(await readWorkspaceGitInfo(dir, { gitPath: noisy }), { branch: "feature/review" });
  },
);

test(
  "readWorkspaceGitInfo ignores the warnings of a real git config",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    const root = await createRepo("feature/review");
    git(root, "config", "core.fsyncObjectFiles", "true");
    assert.deepEqual(await readWorkspaceGitInfo(root), { branch: "feature/review" });
  },
);

test(
  "readWorkspaceGitInfo returns the branch before the first commit",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    // 初回コミット前は rev-parse が失敗するため、symbolic-ref だけがブランチ名を答える
    const root = await mkdtemp(join(tmpdir(), "pi-sbx-freshrepo-"));
    git(root, "init", "-q", "-b", "main");
    assert.deepEqual(await readWorkspaceGitInfo(root), { branch: "main" });
  },
);

test(
  "readWorkspaceGitInfo returns the short commit for a detached HEAD",
  { skip: !HAS_GIT && GIT_SKIP_REASON },
  async () => {
    const root = await createRepo("main");
    git(root, "checkout", "-q", "--detach");
    const info = await readWorkspaceGitInfo(root);
    assert.match(info.branch ?? "", /^[0-9a-f]{7,}$/);
  },
);
