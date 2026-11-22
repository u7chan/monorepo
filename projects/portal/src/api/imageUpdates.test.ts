// 新着イメージ判定 API の対象・キャッシュ・レスポンス契約のユニットテスト

import { describe, expect, test } from "bun:test";
import { mockImageTags } from "../services/mockData";
import type { Container, ImageTagOption } from "../types/container";
import {
  collectImageUpdates,
  createTagCache,
  getImageUpdates,
  type ContainerLoader,
  type TagLoader,
} from "./imageUpdates";

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: "abc123",
    name: "app",
    image: "ghcr.io/u7chan/monorepo/app:sha-1234567",
    state: "running",
    status: "Up 1 hour",
    ports: [],
    canDeploy: true,
    deployTarget: "app",
    ...overrides,
  };
}

function loaderFor(...items: Container[]): ContainerLoader {
  return async () => items;
}

function tagsFor(tags: ImageTagOption[]): TagLoader {
  return async () => tags;
}

async function withMockMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.USE_MOCK_DATA;
  process.env.USE_MOCK_DATA = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.USE_MOCK_DATA;
    } else {
      process.env.USE_MOCK_DATA = previous;
    }
  }
}

const TAGS: ImageTagOption[] = [
  { tag: "sha-new", createdAt: "2026-11-13T13:06:22Z" },
  { tag: "manual-new", createdAt: "2026-11-13T13:06:22Z" },
  { tag: "sha-old", createdAt: "2026-11-12T09:00:00Z" },
];

function updatesRequest(
  loadContainers: ContainerLoader,
  loadTags: TagLoader = tagsFor(TAGS),
): Promise<Response> {
  return getImageUpdates(
    new Request("http://portal.example/api/image-updates"),
    loadContainers,
    loadTags,
  );
}

describe("collectImageUpdates", () => {
  const tagsByProject = new Map<string, readonly ImageTagOption[]>([["app", TAGS]]);

  test("稼働中のタグより新しいビルドがあれば、そのタグと日時を返す", () => {
    const containers = [container({ image: "ghcr.io/u7chan/monorepo/app:sha-old" })];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([
      {
        containerId: "abc123",
        latestTag: "sha-new",
        createdAt: "2026-11-13T13:06:22Z",
      },
    ]);
  });

  test("最新のビルドが動いていれば返さない", () => {
    const containers = [container({ image: "ghcr.io/u7chan/monorepo/app:sha-new" })];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([]);
  });

  test("Deploy を出さないコンテナは、新しいビルドがあっても返さない", () => {
    const containers = [
      container({ canDeploy: false, image: "ghcr.io/u7chan/monorepo/app:sha-old" }),
    ];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([]);
  });

  test("monorepo 外のイメージは返さない", () => {
    const containers = [container({ image: "nginx:alpine" })];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([]);
  });

  test("現在のタグが一覧に無い、または digest 参照なら返さない", () => {
    const containers = [
      container({ id: "latest", image: "ghcr.io/u7chan/monorepo/app:latest" }),
      container({ id: "digest", image: "ghcr.io/u7chan/monorepo/app@sha256:abc123" }),
      container({ id: "gone", image: "ghcr.io/u7chan/monorepo/app:sha-gone" }),
    ];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([]);
  });

  test("タグが取れなかった project は、その project のコンテナだけ返さない", () => {
    const containers = [
      container({ id: "app", image: "ghcr.io/u7chan/monorepo/app:sha-old" }),
      container({ id: "other", name: "other", image: "ghcr.io/u7chan/monorepo/other:sha-old" }),
    ];

    expect(collectImageUpdates(containers, tagsByProject)).toEqual([
      {
        containerId: "app",
        latestTag: "sha-new",
        createdAt: "2026-11-13T13:06:22Z",
      },
    ]);
  });
});

describe("createTagCache", () => {
  test("TTL 内は同じ一覧を使い、期限が切れたら取り直す", async () => {
    let now = 0;
    let calls = 0;
    const loadTags = createTagCache(
      async () => {
        calls += 1;
        return TAGS;
      },
      () => now,
    );

    expect(await loadTags("app")).toBe(TAGS);
    expect(await loadTags("app")).toBe(TAGS);
    expect(calls).toBe(1);

    now += 5 * 60 * 1000;
    await loadTags("app");
    expect(calls).toBe(2);
  });

  test("project ごとにキャッシュする", async () => {
    let calls = 0;
    const loadTags = createTagCache(
      async (project) => {
        calls += 1;
        return project === "app" ? TAGS : [];
      },
      () => 0,
    );

    await loadTags("app");
    await loadTags("other");
    await loadTags("app");

    expect(calls).toBe(2);
  });

  test("失敗は空の一覧として短くキャッシュし、その間は取り直さない", async () => {
    let now = 0;
    let calls = 0;
    const logged: string[] = [];
    const loadTags = createTagCache(
      async () => {
        calls += 1;
        throw new Error("GitHub is down");
      },
      () => now,
      (message) => logged.push(message),
    );

    expect(await loadTags("app")).toEqual([]);
    expect(await loadTags("app")).toEqual([]);
    expect(calls).toBe(1);
    expect(logged).toHaveLength(1);

    now += 60 * 1000;
    expect(await loadTags("app")).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("getImageUpdates", () => {
  test("新着のあるコンテナだけを 200 で返す", async () => {
    const containers = [
      container({ id: "newer", image: "ghcr.io/u7chan/monorepo/app:sha-old" }),
      container({ id: "current", image: "ghcr.io/u7chan/monorepo/app:sha-new" }),
      container({ id: "other", image: "nginx:alpine", canDeploy: false }),
    ];

    const response = await updatesRequest(loaderFor(...containers));
    const body = (await response.json()) as { updates: unknown[]; timestamp: string };

    expect(response.status).toBe(200);
    expect(body.updates).toEqual([
      {
        containerId: "newer",
        latestTag: "sha-new",
        createdAt: "2026-11-13T13:06:22Z",
      },
    ]);
    expect(typeof body.timestamp).toBe("string");
  });

  test("タグ取得に失敗しても、200 で新着なしを返す", async () => {
    const response = await updatesRequest(loaderFor(container()), async () => {
      throw new Error("GitHub is down");
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updates: [] });
  });

  test("コンテナ一覧の取得に失敗したら 500 を返す", async () => {
    const response = await updatesRequest(async () => {
      throw new Error("docker is down");
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to fetch image updates" });
  });

  test("モックモードではモックのタグで判定する", async () => {
    const u7agent = container({
      id: "u7agent",
      name: "u7agent",
      image: "ghcr.io/u7chan/monorepo/u7agent:sha-0ff5c111",
      canDeploy: true,
      deployTarget: "u7agent",
    });

    await withMockMode(async () => {
      const response = await updatesRequest(loaderFor(u7agent), async () => {
        throw new Error("GitHub must not be called in mock mode");
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        updates: [
          {
            containerId: "u7agent",
            latestTag: mockImageTags[0]?.tag,
            createdAt: mockImageTags[0]?.createdAt,
          },
        ],
      });
    });
  });
});
