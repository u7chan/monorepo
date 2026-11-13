// 設定 → Git の API（GET / PUT / DELETE /api/settings/git）。stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { GitSettingsService } from "../src/git-settings";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** ブラウザからの same-origin 要求を模す (この API はヘッダの無い直接クライアントを拒否する) */
const sameOrigin = { Origin: "http://localhost" };

const jsonRequest = (method: "PUT" | "DELETE", payload?: unknown): RequestInit =>
  payload === undefined
    ? { method, headers: sameOrigin }
    : { method, headers: { ...sameOrigin, "Content-Type": "application/json" }, body: JSON.stringify(payload) };

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-git-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET は未設定、PUT は保存して次の bash 用の identity になり、DELETE は冪等に戻す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/git")), {
        userName: null,
        userEmail: null,
        configured: false,
      });
      assert.ok(pi.gitIdentitySources.length > 0, "setGitIdentity が注入されていない");
      assert.equal(pi.gitIdentitySources.at(-1)?.identityForExec(), null);

      const saved = await jsonBody(
        await bff.app.request(
          "/api/settings/git",
          jsonRequest("PUT", { userName: "u7chan", userEmail: "u7chan@example.com" }),
        ),
      );
      assert.deepEqual(saved, {
        userName: "u7chan",
        userEmail: "u7chan@example.com",
        configured: true,
        state: "applied",
      });
      assert.deepEqual(pi.gitIdentitySources.at(-1)?.identityForExec(), {
        userName: "u7chan",
        userEmail: "u7chan@example.com",
      });
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/git")), {
        userName: "u7chan",
        userEmail: "u7chan@example.com",
        configured: true,
      });

      const cleared = await jsonBody(await bff.app.request("/api/settings/git", jsonRequest("DELETE")));
      assert.deepEqual(cleared, { userName: null, userEmail: null, configured: false, state: "applied" });
      assert.equal(pi.gitIdentitySources.at(-1)?.identityForExec(), null);
      // 冪等
      assert.equal((await bff.app.request("/api/settings/git", jsonRequest("DELETE"))).status, 200);
    } finally {
      await bff.close();
    }
  });
});

test("片方だけ・空・制御文字・形状違反は 400 で保存しない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      for (const body of [
        { userName: "u7chan" },
        { userEmail: "u7chan@example.com" },
        { userName: "u7chan", userEmail: "" },
        { userName: "u7chan\n", userEmail: "u7chan@example.com" },
        { userName: "u7<chan", userEmail: "u7chan@example.com" },
        { userName: "u7chan", userEmail: "not-an-email" },
      ]) {
        const response = await bff.app.request("/api/settings/git", jsonRequest("PUT", body));
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.ok(((await response.json()) as { error?: string }).error);
      }
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/git")), {
        userName: null,
        userEmail: null,
        configured: false,
      });
    } finally {
      await bff.close();
    }
  });
});

test("変更系は same-origin のヘッダが無ければ 403", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      // ヘッダ無し (curl 相当) は通さない
      const noHeaders = await bff.app.request("/api/settings/git", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName: "u7chan", userEmail: "u7chan@example.com" }),
      });
      assert.equal(noHeaders.status, 403);

      // 別 origin も拒否する
      const crossOrigin = await bff.app.request("/api/settings/git", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ userName: "u7chan", userEmail: "u7chan@example.com" }),
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal((await bff.app.request("/api/settings/git", { method: "DELETE" })).status, 403);

      // Sec-Fetch-Site だけでも same-origin なら通す
      const siteOnly = await bff.app.request("/api/settings/git", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ userName: "u7chan", userEmail: "u7chan@example.com" }),
      });
      assert.equal(siteOnly.status, 200);
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/git")), {
        userName: "u7chan",
        userEmail: "u7chan@example.com",
        configured: true,
      });
    } finally {
      await bff.close();
    }
  });
});

test("DB に永続化され、再起動後も同じ identity を返す", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      assert.equal(
        (
          await first.app.request(
            "/api/settings/git",
            jsonRequest("PUT", { userName: "u7chan", userEmail: "u7chan@example.com" }),
          )
        ).status,
        200,
      );
    } finally {
      await first.close();
    }
    const second = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      assert.deepEqual(await jsonBody(await second.app.request("/api/settings/git")), {
        userName: "u7chan",
        userEmail: "u7chan@example.com",
        configured: true,
      });
    } finally {
      await second.close();
    }
  });
});

test("DB 障害で設定を読めないときは 503 と not_stored、exec 用は null に倒す", async () => {
  const failing = {
    readGitSettings: () => {
      throw new Error("db unavailable");
    },
    saveGitSettings: () => {
      throw new Error("db unavailable");
    },
    clearGitSettings: () => {
      throw new Error("db unavailable");
    },
  };
  const service = new GitSettingsService({ db: failing });
  assert.throws(() => service.settings(), /保存できませんでした/);
  assert.equal(service.identityForExec(), null);
  assert.deepEqual(await service.put({ userName: "u7chan", userEmail: "u7chan@example.com" }), {
    status: 503,
    error: "Git の設定をアプリデータ（SQLite）へ保存できませんでした",
  });
  assert.deepEqual(await service.clear(), {
    status: 503,
    error: "Git の設定をアプリデータ（SQLite）へ保存できませんでした",
  });
});

test("壊れた保存値は exec 用に渡さず null へ倒す", () => {
  const broken = new GitSettingsService({
    db: {
      readGitSettings: () => ({ userName: "u7\nchan", userEmail: "u7chan@example.com" }),
      saveGitSettings: () => {},
      clearGitSettings: () => {},
    },
  });
  assert.equal(broken.identityForExec(), null);
  assert.deepEqual(broken.settings(), { userName: "u7\nchan", userEmail: "u7chan@example.com", configured: true });
});
