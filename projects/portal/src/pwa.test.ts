// PWA 用の manifest とアイコン

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { staticRoutes } from "./static";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: staticRoutes,
  fetch: () => new Response(null, { status: 404 }),
});

afterAll(() => server.stop(true));

describe("PWA 用の静的アセット", () => {
  test("manifest はルートから standalone で起動する設定を返す", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(new URL("/manifest.webmanifest", server.url));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/manifest+json");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual({
        id: "/",
        name: "Docker Container Portal",
        short_name: "Portal",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#0a0a0b",
        background_color: "#0a0a0b",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      });
    }
  });

  test.each([
    ["/icons/icon-192.png", 192],
    ["/icons/icon-512.png", 512],
    ["/apple-touch-icon.png", 180],
  ] as const)("%s は宣言どおりのサイズの PNG を返す", async (path, size) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(new URL(path, server.url));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");

      const bytes = Buffer.from(await response.arrayBuffer());

      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
    }
  });

  test("HTML のバンドル後も manifest と Apple touch icon を参照できる", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "portal-assets-"));

    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "build",
          "./src/index.html",
          "--outdir",
          outputDir,
          "--log-level=error",
        ],
        cwd: new URL("..", import.meta.url).pathname,
      });

      expect(result.exitCode, result.stderr.toString()).toBe(0);

      const page = pathToFileURL(join(outputDir, "index.html"));
      const html = await Bun.file(page).text();
      const manifestHref = html.match(/<link\b(?=[^>]*\brel="manifest")[^>]*\bhref="([^"]+)"/)?.[1];
      const appleHref = html.match(
        /<link\b(?=[^>]*\brel="apple-touch-icon")[^>]*\bhref="([^"]+)"/,
      )?.[1];

      expect(manifestHref).toBeDefined();
      expect(appleHref).toBeDefined();

      const manifest = Bun.file(new URL(manifestHref!, page));
      const appleIcon = Bun.file(new URL(appleHref!, page));
      const publicManifest = await fetch(new URL("/manifest.webmanifest", server.url));
      const publicAppleIcon = await fetch(new URL("/apple-touch-icon.png", server.url));

      expect(manifest.type).toBe("application/manifest+json");
      expect(await manifest.json()).toEqual(await publicManifest.json());
      expect(appleIcon.type).toBe("image/png");
      expect(await appleIcon.arrayBuffer()).toEqual(await publicAppleIcon.arrayBuffer());
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
