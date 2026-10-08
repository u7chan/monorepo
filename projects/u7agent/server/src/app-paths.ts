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

const SESSION_ID_PATTERN = /^[0-9a-f]{10}$/;

/** 10 hex 文字のセッション ID か。store のフォルダ走査とパス組み立ての共通判定。 */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
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

/** 未所属セッションのスクラッチ (root 相対)。永続化ありでのみ作る。 */
export function sessionWorkdirRel(id: string, spaceId = "default"): string {
  assertSessionId(id);
  return spaceIdOf(spaceId) === "default"
    ? `${SESSION_DIR_REL}/${id}`
    : `${APP_DIR_REL}/spaces/${spaceId}/sessions/${id}`;
}

/** 添付の保存先 (root 相対)。所属に関係なく全セッションで `<appdir>/uploads/<id>` に統一する。 */
export function sessionUploadsRel(id: string, spaceId = "default"): string {
  assertSessionId(id);
  return spaceIdOf(spaceId) === "default"
    ? `${UPLOADS_DIR_REL}/${id}`
    : `${APP_DIR_REL}/spaces/${spaceId}/uploads/${id}`;
}

/** root 相対のディレクトリを BFF 側の絶対パスへ。`""` は root 自身。 */
export function workspaceAbs(rootCwd: string, relative: string): string {
  return relative ? resolve(rootCwd, relative) : resolve(rootCwd);
}
