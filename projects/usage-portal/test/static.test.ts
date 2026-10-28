import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { staticRoutes } from "../src/server/static";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: staticRoutes,
  fetch: () => new Response(null, { status: 404 }),
});

afterAll(() => server.stop(true));

describe("ブラウザ用の静的アセット", () => {
  test("HTML をバンドルすると 32px の PNG favicon が参照先に含まれる", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "usage-portal-assets-"));

    try {
      // bun:test 内の HTML バンドルは参照先の解決に失敗するため、別プロセスを使う。
      const result = Bun.spawnSync({
        cmd: [process.execPath, "build", "./index.html", "--outdir", outputDir],
        cwd: new URL("..", import.meta.url).pathname,
      });

      expect(result.exitCode, result.stderr.toString()).toBe(0);

      const page = pathToFileURL(join(outputDir, "index.html"));
      const html = await Bun.file(page).text();
      const href = html.match(/<link\b(?=[^>]*\brel="icon")(?=[^>]*\btype="image\/png")[^>]*\bhref="([^"]+)"/)?.[1];

      expect(href).toBeDefined();

      const icon = Bun.file(new URL(href!, page));

      expect(icon.type).toContain("image/png");

      const bytes = Buffer.from(await icon.arrayBuffer());

      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(32);
      expect(bytes.readUInt32BE(20)).toBe(32);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("/favicon.ico は未認証でも 16・32・48px を含む ICO として繰り返し取得できる", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const icon = await fetch(new URL("/favicon.ico", server.url));

      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/x-icon");
      expect(icon.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff");

      const bytes = Buffer.from(await icon.arrayBuffer());

      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      expect(bytes.readUInt16LE(4)).toBe(3);
      expect([0, 1, 2].map((index) => [bytes[6 + index * 16], bytes[7 + index * 16]])).toEqual([
        [16, 16],
        [32, 32],
        [48, 48],
      ]);
    }
  });
});
