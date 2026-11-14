// GHCR のタグ一覧と、self-hosted-runner の manual-deploy 起動。
// デプロイの実体は workflow に任せ、portal は対象とイメージタグを渡すだけにする。

import type { ImageTagOption } from "../types/container";
import { isValidDeployTarget, isValidImageTag } from "../lib/image";

const GITHUB_API = "https://api.github.com";
const PACKAGE_OWNER = "u7chan";
const PACKAGE_PREFIX = "monorepo";
const DEPLOY_REPOSITORY = "u7chan/self-hosted-runner";
const DEPLOY_WORKFLOW = "manual-deploy.yml";
const DEPLOY_REF = "main";

export const DEPLOY_WORKFLOW_URL = `https://github.com/${DEPLOY_REPOSITORY}/actions/workflows/${DEPLOY_WORKFLOW}`;

export class GithubServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GithubServiceError";
  }
}

interface PackageVersion {
  created_at: string;
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
}

function getToken(): string | undefined {
  return process.env.PORTAL_GITHUB_TOKEN?.trim() || undefined;
}

function requireToken(): string {
  const token = getToken();
  if (!token) {
    throw new GithubServiceError(
      "Deploy is not configured. Set PORTAL_GITHUB_TOKEN on the host.",
      503,
    );
  }
  return token;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "portal-deploy",
  };
}

function mapGithubStatus(status: number): number {
  // 401/403/429 は portal 側の設定・レート制限。404/422 は対象や入力の問題。
  return status === 401 || status === 403 || status === 429 ? 503 : 502;
}

async function readGithubMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message;
    }
  } catch {
    // JSON でない応答はステータスだけを返す
  }
  return `GitHub API returned ${response.status}`;
}

function isPackageVersion(value: unknown): value is PackageVersion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as Record<string, unknown>).created_at === "string";
}

/**
 * GitHub Packages の versions を、タグの選択肢へ平坦化する。
 * 同じタグが複数 version に出ることはないが、念のため新しい方を残す。
 */
export function toImageTagOptions(versions: PackageVersion[]): ImageTagOption[] {
  const seen = new Set<string>();
  const options: ImageTagOption[] = [];

  for (const version of [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    for (const tag of version.metadata?.container?.tags ?? []) {
      if (!tag || !isValidImageTag(tag) || seen.has(tag)) continue;
      seen.add(tag);
      options.push({ tag, createdAt: version.created_at });
    }
  }

  return options;
}

export async function listImageTags(project: string): Promise<ImageTagOption[]> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(project)) {
    throw new GithubServiceError(`Invalid image project: ${project}`, 400);
  }

  const token = requireToken();
  const packageName = encodeURIComponent(`${PACKAGE_PREFIX}/${project}`);
  const url = `${GITHUB_API}/users/${PACKAGE_OWNER}/packages/container/${packageName}/versions?per_page=100`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubServiceError("GitHub API is unreachable", 502);
  }

  if (!response.ok) {
    throw new GithubServiceError(
      await readGithubMessage(response),
      mapGithubStatus(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GithubServiceError("GitHub API returned an invalid response", 502);
  }

  if (!Array.isArray(body)) {
    throw new GithubServiceError("GitHub API returned an invalid response", 502);
  }

  return toImageTagOptions(body.filter(isPackageVersion));
}

export async function dispatchDeploy(target: string, tag: string): Promise<string> {
  if (!isValidDeployTarget(target)) {
    throw new GithubServiceError(`Invalid deploy target: ${target}`, 400);
  }
  if (!isValidImageTag(tag)) {
    throw new GithubServiceError(`Invalid image tag: ${tag}`, 400);
  }

  const token = requireToken();
  const url = `${GITHUB_API}/repos/${DEPLOY_REPOSITORY}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: DEPLOY_REF,
        inputs: {
          target,
          image_tag: tag,
          action: "deploy",
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubServiceError("GitHub API is unreachable", 502);
  }

  if (!response.ok) {
    throw new GithubServiceError(
      await readGithubMessage(response),
      mapGithubStatus(response.status),
    );
  }

  return DEPLOY_WORKFLOW_URL;
}
