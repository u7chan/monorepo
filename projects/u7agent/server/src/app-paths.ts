/**
 * アプリ専用ディレクトリ (`<workspace root>/.u7agent`) の配置。プロジェクト (ユーザーが登録する
 * ディレクトリ) と同じツリーを共有するため、境界 (プロジェクトとして登録できない範囲・未所属セッションの
 * スクラッチ・添付の保存先) をここ 1 箇所で決める。
 */
import { resolve } from "node:path";

export const APP_DIR_REL = ".u7agent";
export const SESSION_DIR_REL = `${APP_DIR_REL}/sessions`;
export const UPLOADS_DIR_REL = `${APP_DIR_REL}/uploads`;

const SESSION_ID_PATTERN = /^[0-9a-f]{10}$/;

/** 10 hex 文字のセッション ID か。store のフォルダ走査とパス組み立ての共通判定。 */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`セッション ID が不正です: ${id}`);
}

/** `<appdir>` 自身と配下。プロジェクトとして登録できない (ファイル画面の root には置けない)。 */
export function isAppDirPath(relative: string): boolean {
  return relative === APP_DIR_REL || relative.startsWith(`${APP_DIR_REL}/`);
}

/** 未所属セッションのスクラッチ (root 相対)。永続化ありでのみ作る。 */
export function sessionWorkdirRel(id: string): string {
  assertSessionId(id);
  return `${SESSION_DIR_REL}/${id}`;
}

/** 添付の保存先 (root 相対)。所属に関係なく全セッションで `<appdir>/uploads/<id>` に統一する。 */
export function sessionUploadsRel(id: string): string {
  assertSessionId(id);
  return `${UPLOADS_DIR_REL}/${id}`;
}

/** root 相対のディレクトリを BFF 側の絶対パスへ。`""` は root 自身。 */
export function workspaceAbs(rootCwd: string, relative: string): string {
  return relative ? resolve(rootCwd, relative) : resolve(rootCwd);
}
