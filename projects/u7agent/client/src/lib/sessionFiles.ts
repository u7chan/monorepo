/**
 * チャットから選択中セッションの作業フォルダを開くための root を決める。
 * 表示方法は layout ごとに変え、desktop は右パネル、singleColumn は全画面シートを使う。
 */

export type SessionFilesAvailability = {
  /** チャット画面のときだけ出す。設定ページでは 設定 → ファイル と二重になるため出さない */
  chatView: boolean;
  /** 選択中セッションの作業フォルダ。未作成チャット (sessionId が空) では "" */
  cwd: string;
  /**
   * セッション未作成で作成先プロジェクトが解決済みのときだけ渡す selectedProject.cwd。
   * セッションがあるときに渡すと、選択待ちの cwd "" に作成先の別プロジェクトのツリーが出る
   */
  projectCwd: string;
};

/**
 * 作業フォルダを出す root。"" は「出さない」を意味する。
 * ワークスペース root (".") へはフォールバックしない (設定 → ファイル との混同を避ける)。
 */
export function sessionFilesRoot({ chatView, cwd, projectCwd }: SessionFilesAvailability): string {
  if (!chatView) return "";
  return cwd || projectCwd;
}

export type SessionFilesDefaultOpen = {
  /** portrait / landscape。既定オープンの対象は desktop のパネルだけ (シートは手動トグル) */
  singleColumn: boolean;
  /** そのときの作成先。"" は未所属 */
  projectId: string;
};

/**
 * desktop のパネルの既定値。プロジェクト配下の新規会話だけ開き、使うのは利用者操作の新規会話の
 * 入口 (App の handleNewChat) だけ (派生 state を契機に変えない)。
 */
export function sessionFilesDefaultOpen({ singleColumn, projectId }: SessionFilesDefaultOpen): boolean {
  return !singleColumn && projectId !== "";
}

/**
 * 作業環境パネルのツリーで隠す名前。`.git` は上限まで溢れる割に作業中に読み書きせず、ネストした
 * repo でも同じノイズになるため名前一致で隠す (設定 → ファイル は隠さない。docs/file-tree.md#隠す行)。
 */
export const SESSION_FILES_HIDDEN_NAMES: readonly string[] = [".git"];

/**
 * ルート直下の `index.html` から作業フォルダ自身を共有できるか。プロジェクト会話はプロジェクト全体の
 * 公開になるため、`projectSession` が明示的な false のときだけ許可する (未ロードは出さない側)。
 */
export function canShareSessionRoot(input: { sessionId?: string; projectSession?: boolean }): boolean {
  return (input.sessionId ?? "") !== "" && input.projectSession === false;
}
