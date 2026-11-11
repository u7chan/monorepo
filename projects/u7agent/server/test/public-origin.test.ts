// 公開オリジン (env) の契約。TLS 終端の後ろで scheme が変わる 4 か所 (Origin 検査 / CSP / iframe / リンク) と
// サービス プロキシの Location を、未設定なら現行のまま・設定すればその origin に寄せることを固定する。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { publicOriginsLogLine, resolvePublicOrigins } from "../src/public-origin";
import type { PublicOriginEnv } from "../src/public-origin";
import { createServiceProxy } from "../src/service-proxy";

test("解決は http(s) の絶対 URL だけを受け、末尾の / は落とす", () => {
  assert.deepEqual(
    resolvePublicOrigins({
      PI_APP_ORIGIN: "https://agent.example.com",
      PI_FILE_PREVIEW_ORIGIN: "https://preview.example.com/",
      PI_PREVIEW_ORIGIN: "http://service.example.com:8443",
    }),
    {
      appOrigin: "https://agent.example.com",
      filePreviewOrigin: "https://preview.example.com",
      serviceOrigin: "http://service.example.com:8443",
    },
  );
  // 空白だけは未設定として扱う (compose の空の変数で起動を止めない)
  assert.deepEqual(
    resolvePublicOrigins({ PI_APP_ORIGIN: "", PI_FILE_PREVIEW_ORIGIN: "  ", PI_PREVIEW_ORIGIN: undefined }),
    {},
  );
});

test("相対 URL・非 http(s)・パス・クエリ・フラグメント・資格情報は起動時に止める", () => {
  const invalid: Array<[keyof PublicOriginEnv, string]> = [
    ["PI_APP_ORIGIN", "agent.example.com"],
    ["PI_APP_ORIGIN", "/app"],
    ["PI_APP_ORIGIN", "ftp://agent.example.com"],
    ["PI_APP_ORIGIN", "https://agent.example.com/app"],
    ["PI_FILE_PREVIEW_ORIGIN", "https://preview.example.com/?a=1"],
    ["PI_PREVIEW_ORIGIN", "https://service.example.com/#top"],
    ["PI_PREVIEW_ORIGIN", "https://user:secret@service.example.com"],
  ];
  for (const [name, value] of invalid) {
    // 誤った値は画面に出ず、リンクが開けないだけなので、起動時に env 名と値を見せて止める
    assert.throws(
      () => resolvePublicOrigins({ [name]: value } as PublicOriginEnv),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return message.includes(name) && message.includes(value);
      },
      `${name}=${value}`,
    );
  }
});

test("起動ログは設定済みの env だけを 1 行にし、未設定なら出さない", () => {
  assert.equal(publicOriginsLogLine({}), undefined);
  assert.equal(
    publicOriginsLogLine({ appOrigin: "https://agent.example.com", serviceOrigin: "https://service.example.com" }),
    "PI_APP_ORIGIN=https://agent.example.com, PI_PREVIEW_ORIGIN=https://service.example.com",
  );
});

test("health は未設定なら 3 キーを出さず、設定済みのときだけ値を載せる (ポートは常に残す)", async () => {
  const unset = await createBffApp({ pi: null, sessionStoreDir: null });
  const configured = await createBffApp({
    pi: null,
    sessionStoreDir: null,
    appOrigin: "https://agent.example.com",
    filePreviewOrigin: "https://preview.example.com",
    serviceOrigin: "https://service.example.com",
  });
  try {
    const before = (await (await unset.app.request("/api/health")).json()) as Record<string, unknown>;
    assert.equal(before.filePreviewPort, 4318);
    assert.equal(before.previewPort, 4319);
    for (const key of ["appOrigin", "filePreviewOrigin", "serviceOrigin"]) {
      assert.equal(key in before, false, key);
    }

    const after = (await (await configured.app.request("/api/health")).json()) as Record<string, unknown>;
    assert.equal(after.filePreviewPort, 4318);
    assert.equal(after.previewPort, 4319);
    assert.equal(after.appOrigin, "https://agent.example.com");
    assert.equal(after.filePreviewOrigin, "https://preview.example.com");
    assert.equal(after.serviceOrigin, "https://service.example.com");
  } finally {
    await unset.close();
    await configured.close();
  }
});

test("アプリ CSP は filePreviewOrigin があればその origin を frame-src にし、'self' は残す", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "bff-origin-"));
  await writeFile(join(distDir, "index.html"), "<html>ok</html>");
  const unset = await createBffApp({
    pi: null,
    sessionStoreDir: null,
    clientDistDir: distDir,
    filePreviewPort: 4318,
  });
  const configured = await createBffApp({
    pi: null,
    sessionStoreDir: null,
    clientDistDir: distDir,
    filePreviewPort: 4318,
    filePreviewOrigin: "https://preview.example.com",
  });
  try {
    const before = (await unset.app.request("/")).headers.get("content-security-policy") ?? "";
    assert.match(before, /frame-src 'self' http:\/\/\*:4318/);
    const after = (await configured.app.request("/")).headers.get("content-security-policy") ?? "";
    assert.match(after, /frame-src 'self' https:\/\/preview\.example\.com/);
    // 設定済みでも同一オリジンのフレーム (別オリジンを OFF にしたプレビュー) は許可する
    assert.equal(after.includes("http://*:4318"), false);
  } finally {
    await unset.close();
    await configured.close();
    await rm(distDir, { recursive: true, force: true });
  }
});

test("Origin 検査は設定した appOrigin とリクエスト自身の origin の両方を許可し、他のオリジンは拒否する", async () => {
  const bff = await createBffApp({
    pi: null,
    sessionStoreDir: null,
    appOrigin: "https://agent.example.com",
  });
  try {
    // ブラウザの Origin は TLS 終端の後ろで https になる (BFF が見るリクエストの origin は http)
    const viaProxy = await bff.app.request("http://agent.example.com/api/agents", {
      method: "POST",
      headers: { Origin: "https://agent.example.com" },
      body: JSON.stringify({ name: "via-proxy" }),
    });
    assert.equal(viaProxy.status, 201);
    // 直通ポート (http) の操作は移行期間のため現行どおり許可する
    const direct = await bff.app.request("http://agent.example.com:8015/api/agents", {
      method: "POST",
      headers: { Origin: "http://agent.example.com:8015" },
      body: JSON.stringify({ name: "direct" }),
    });
    assert.equal(direct.status, 201);
    const foreign = await bff.app.request("http://agent.example.com/api/agents", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
      body: JSON.stringify({ name: "foreign" }),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await bff.close();
  }
});

/** 上流 (サンドボックスの 8080 で待つアプリ) を立てる。実ポートはカーネルに任せる */
async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("上流のポートを解決できません");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("サービスの Location は serviceOrigin があればそこへ、無ければリクエスト自身の origin へ書き換える", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:8080/next?x=1" });
    res.end();
  });
  const configured = createServiceProxy({
    host: "127.0.0.1",
    port: upstream.port,
    serviceOrigin: "https://service.example.com",
  });
  const unset = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const proxied = await configured.request("http://service.test/");
    assert.equal(proxied.headers.get("location"), "https://service.example.com/next?x=1");
    const direct = await unset.request("http://service.test/");
    assert.equal(direct.headers.get("location"), "http://service.test/next?x=1");
  } finally {
    await upstream.close();
  }
});
