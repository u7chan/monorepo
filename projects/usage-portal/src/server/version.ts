import { readFileSync } from "node:fs";

export function readPackageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json に version がありません");
  }

  return parsed.version;
}

export function resolveVersion(commitHash: string | undefined, packageVersion: string): string {
  const commit = commitHash?.trim() ?? "";

  return commit === "" ? packageVersion : commit;
}

export function userAgentFor(version: string): string {
  return `usage-portal/${version}`;
}
