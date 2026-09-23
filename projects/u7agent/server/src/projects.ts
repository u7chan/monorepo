/**
 * プロジェクトストア。プロジェクト = ワークスペース内のディレクトリで、
 * cwd は rootCwd 相対で持つ (絶対パスで保存するとマウント先の変更で壊れる)。
 * 実体はアプリデータの SQLite (app-db.ts) にあり、ここは正規化と検証を持つ。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, posix, resolve, sep } from "node:path";
import { APP_DIR_REL, isAppDirPath } from "./app-paths";
import { AppDb } from "./app-db";
import type { Project } from "./schema";

interface HttpLikeError extends Error {
  statusCode?: number;
}

function badRequest(message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.statusCode = 400;
  return error;
}

function conflict(message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.statusCode = 409;
  return error;
}

/** パス区切りは "/" へ正規化する。Windows では "\" も区切りとして扱う (脱出の見落としを防ぐ)。 */
function splitSegments(value: string): string[] {
  return value.split(sep === "/" ? "/" : /[\\/]/);
}

/**
 * rootCwd 相対パスを "/" 区切りの正規化パスにする。空文字は root 自身として許容する。
 * 絶対パスと `..` は root の外を指せるため保存・解決の前に拒否する。
 */
export function normalizeWorkspacePath(value: string): string {
  if (typeof value !== "string") throw badRequest("cwd must be a string");
  if (isAbsolute(value)) throw badRequest(`cwd must be a relative path: ${value}`);
  const segments: string[] = [];
  for (const segment of splitSegments(value)) {
    if (segment === "" || segment === ".") continue;
    // 字句的に畳まず拒否する。`a/../b` のような指定を root 内へ読み替えると、判定の根拠が曖昧になる。
    if (segment === "..") throw badRequest(`cwd must not contain "..": ${value}`);
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * プロジェクト cwd。root 自身とアプリの作業ディレクトリ (`<appdir>`) はプロジェクトにできない
 * (前者は未所属セッションの作業場所、後者はセッションのスクラッチと添付の置き場)。
 */
export function normalizeProjectCwd(value: string): string {
  const path = normalizeWorkspacePath(value);
  if (!path) throw badRequest("cwd must not be the workspace root");
  if (isAppDirPath(path)) throw badRequest(`cwd must not be under ${APP_DIR_REL}: ${value}`);
  return path;
}

/**
 * rootCwd 相対の作業ディレクトリを絶対パスへ解決する。相対形も返し、
 * サンドボックス (相対を受ける) と BFF のセッション (絶対パスを要る) へ同じ指定を渡せるようにする。
 */
export function resolveWorkspaceCwd(rootCwd: string, requestedCwd: string): { relative: string; absolute: string } {
  const relative = normalizeWorkspacePath(requestedCwd);
  return { relative, absolute: relative ? resolve(rootCwd, relative) : resolve(rootCwd) };
}

export interface CreateProjectInput {
  cwd: string;
  name?: string;
}

export class ProjectStore {
  #db: AppDb;

  /** db 未指定はメモリ DB (カタログの単体テストと同じ扱い) */
  constructor(db?: AppDb) {
    this.#db = db ?? AppDb.open({ storeDir: null });
  }

  /** 作成順 */
  list(): Project[] {
    return this.#db.listProjects();
  }

  get(id: string): Project | undefined {
    return this.#db.getProject(id);
  }

  findByCwd(cwd: string): Project | undefined {
    return this.#db.findProjectByCwd(cwd);
  }

  create({ cwd, name }: CreateProjectInput): Project {
    if (this.findByCwd(cwd)) throw conflict(`Project already exists: ${cwd}`);
    const project: Project = {
      id: randomUUID(),
      name: name?.trim() || posix.basename(cwd),
      cwd,
      createdAt: Date.now(),
    };
    this.#db.insertProject(project);
    return project;
  }

  remove(id: string): boolean {
    return this.#db.deleteProject(id);
  }
}
