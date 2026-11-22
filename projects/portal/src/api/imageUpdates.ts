// 稼働中のイメージより新しいビルドが GHCR に届いているかの判定。
// 一覧は 30 秒ごとに更新されるため、タグ取得は project ごとにキャッシュして
// GitHub API のレート制限に当たらないようにする。

import {
  findNewerImageTag,
  hasImageDigest,
  monorepoProject,
  parseImageReference,
} from "../lib/image";
import { fetchContainers } from "../services/docker";
import { listImageTags } from "../services/github";
import { isMockMode, mockImageTags } from "../services/mockData";
import type { Container, ImageTagOption, ImageUpdate } from "../types/container";

export type ContainerLoader = () => Promise<Container[]>;
export type TagLoader = (project: string) => Promise<readonly ImageTagOption[]>;

const TAG_CACHE_TTL_MS = 5 * 60 * 1000;
const TAG_FAILURE_TTL_MS = 60 * 1000;

/**
 * タグ一覧の取得を project ごとにキャッシュする。
 *
 * Why not: 成功だけでなく失敗も短くキャッシュする。token 切れなどで毎回失敗する間、
 * 30 秒ごとに同じ GitHub API を叩き続けないため。失敗は 1 分で取り直す。
 */
export function createTagCache(
  loadTags: TagLoader,
  now: () => number = Date.now,
  logError: (message: string, error: unknown) => void = console.warn,
): TagLoader {
  const cache = new Map<string, { tags: readonly ImageTagOption[]; expiresAt: number }>();
  const inFlight = new Map<string, Promise<readonly ImageTagOption[]>>();

  return (project) => {
    const cached = cache.get(project);
    if (cached && cached.expiresAt > now()) {
      return Promise.resolve(cached.tags);
    }

    // 同じ project の取得中に別のリクエストが来たら、同じ Promise を返す。
    // 個別に取得すると、後から終わった失敗が成功したキャッシュを上書きする。
    const pending = inFlight.get(project);
    if (pending) {
      return pending;
    }

    // loadTags が同期的に throw しても inFlight へ登録してから実行する。
    const request = Promise.resolve()
      .then(() => loadTags(project))
      .then((tags) => {
        cache.set(project, { tags, expiresAt: now() + TAG_CACHE_TTL_MS });
        return tags;
      })
      .catch((error) => {
        logError(`Failed to load image tags for ${project}:`, error);
        cache.set(project, { tags: [], expiresAt: now() + TAG_FAILURE_TTL_MS });
        return [];
      })
      .finally(() => {
        inFlight.delete(project);
      });

    inFlight.set(project, request);
    return request;
  };
}

const cachedTagOptions = createTagCache(listImageTags);

/** 新着判定の対象になる project。Deploy を出さないコンテナは対象外。 */
function deployableProjects(containers: readonly Container[]): string[] {
  const projects = new Set<string>();

  for (const container of containers) {
    if (!container.canDeploy) {
      continue;
    }

    const project = monorepoProject(container.image);
    if (project) {
      projects.add(project);
    }
  }

  return [...projects];
}

/**
 * 取得済みのタグ一覧から、新着のあるコンテナだけを選ぶ。
 * タグが取れなかった project は空の一覧として渡され、印を出さない。
 */
export function collectImageUpdates(
  containers: readonly Container[],
  tagsByProject: ReadonlyMap<string, readonly ImageTagOption[]>,
): ImageUpdate[] {
  const updates: ImageUpdate[] = [];

  for (const container of containers) {
    if (!container.canDeploy) {
      continue;
    }

    const project = monorepoProject(container.image);
    if (!project) {
      continue;
    }

    // digest を固定した参照は、タグを併記していても動いているビルドをタグで表さない。
    if (hasImageDigest(container.image)) {
      continue;
    }

    const tags = tagsByProject.get(project);
    const currentTag = parseImageReference(container.image).tag;
    if (!tags || !currentTag) {
      continue;
    }

    const newer = findNewerImageTag(tags, currentTag);
    if (!newer) {
      continue;
    }

    updates.push({ containerId: container.id, latestTag: newer.tag, createdAt: newer.createdAt });
  }

  return updates;
}

async function loadTagsByProject(
  projects: readonly string[],
  loadTags: TagLoader,
): Promise<Map<string, readonly ImageTagOption[]>> {
  const entries = await Promise.all(
    projects.map(async (project) => {
      try {
        return [project, await loadTags(project)] as const;
      } catch {
        // 1 つの project が取れなくても、他の project の新着は出したい。
        return [project, []] as const;
      }
    }),
  );

  return new Map(entries);
}

const loadAllContainers: ContainerLoader = () => fetchContainers(true);

export async function getImageUpdates(
  _req: Request,
  loadContainers: ContainerLoader = loadAllContainers,
  loadTags: TagLoader = cachedTagOptions,
): Promise<Response> {
  try {
    const containers = await loadContainers();
    const projects = deployableProjects(containers);
    const tagsByProject = isMockMode()
      ? new Map(projects.map((project) => [project, mockImageTags] as const))
      : await loadTagsByProject(projects, loadTags);

    return Response.json({
      updates: collectImageUpdates(containers, tagsByProject),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching image updates:", error);
    return Response.json(
      {
        error: "Failed to fetch image updates",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
