/**
 * アプリ専用ディレクトリ (`<workspace root>/.u7agent`) の配置。プロジェクト (ユーザーが登録する
 * ディレクトリ) と同じツリーを共有するため、境界 (プロジェクトとして登録できない範囲・未所属セッションの
 * スクラッチ・添付の保存先) をここ 1 箇所で決める。
 */
import { resolve } from "node:path";
import { spaceIdOf } from "./spaces";

export const APP_DIR_REL = ".u7agent";
export const SESSION_DIR_REL = `${APP_DIR_REL}/sessions`;
export const UPLOADS_DIR_REL = `${APP_DIR_REL}/uploads`;
/** serve (サービス) の稼働記録とログ。公開枠が 1 本なので固定パス 1 組 */
export const SERVE_DIR_REL = `${APP_DIR_REL}/serve`;
export const SERVE_STATE_REL = `${SERVE_DIR_REL}/state.json`;
export const SERVE_LOG_REL = `${SERVE_DIR_REL}/app.log`;
/** デバッグ用 serve のログ。ポートごとに 1 ファイルで、停止しても消さずに残す */
export const SERVE_DEBUG_LOG_DIR_REL = `${SERVE_DIR_REL}/debug`;

export function serveDebugLogRel(port: number): string {
  return `${SERVE_DEBUG_LOG_DIR_REL}/${port}.log`;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{10}$/;

/**
 * 10 hex 文字のセッション ID か。store のフォルダ走査とパス組み立ての共通判定。
 * meta の owner のように外部から来る値を渡すため、型も含めて検査する
 * (正規表現の test は number / 配列を暗黙変換して受理してしまう)。
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`セッション ID が不正です: ${id}`);
}

/** 共通スキル (`.agents/skills`) の置き場 (workspace root 相対)。プロジェクトスキルは `<session cwd>/.agents/skills` */
export const COMMON_SKILLS_DIR = ".agents/skills";

/** `<appdir>` 自身と配下。プロジェクトとして登録できない (ファイル画面の root には置けない)。 */
export function isAppDirPath(relative: string): boolean {
  return relative === APP_DIR_REL || relative.startsWith(`${APP_DIR_REL}/`);
}

/** 追加スペースの根 (root 相対)。既定 (default) は専用の根を持たないので `""`。
 * spaces.ts の `spaceIdOf` が省略だけを寄せ、不正値は 400 にする。 */
export function spaceDirRel(spaceId = "default"): string {
  return spaceIdOf(spaceId) === "default" ? "" : `${APP_DIR_REL}/spaces/${spaceId}`;
}

/** 未所属セッションのスクラッチ (root 相対)。既定 (default) は `SESSION_DIR_REL` 配下、追加スペースは
 * `<appdir>/spaces/<spaceId>/sessions` 配下になる。 */
export function sessionWorkdirRel(id: string, spaceId = "default"): string {
  assertSessionId(id);
  const dir = spaceDirRel(spaceId);
  return dir ? `${dir}/sessions/${id}` : `${SESSION_DIR_REL}/${id}`;
}

/** 添付の保存先 (root 相対)。既定 (default) は `UPLOADS_DIR_REL` 配下、追加スペースは
 * `<appdir>/spaces/<spaceId>/uploads` 配下になる (プロジェクト所属でもリポジトリ内には作らない)。 */
export function sessionUploadsRel(id: string, spaceId = "default"): string {
  assertSessionId(id);
  const dir = spaceDirRel(spaceId);
  return dir ? `${dir}/uploads/${id}` : `${UPLOADS_DIR_REL}/${id}`;
}

/** root 相対のディレクトリを BFF 側の絶対パスへ。`""` は root 自身。 */
export function workspaceAbs(rootCwd: string, relative: string): string {
  return relative ? resolve(rootCwd, relative) : resolve(rootCwd);
}
