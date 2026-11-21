// /api ルート表のメソッド非依存な契約テスト

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiRoutes } from "./routes";

let server!: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, development: false, routes: apiRoutes });
});

afterAll(() => {
  server.stop(true);
});

describe("/api/hello/:name", () => {
  for (const method of ["PUT", "POST", "DELETE"] as const) {
    test(`${method} も GET と同じ JSON を返す`, async () => {
      const response = await fetch(new URL("/api/hello/foo", server.url), { method });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ message: "Hello, foo!" });
    });
  }
});
