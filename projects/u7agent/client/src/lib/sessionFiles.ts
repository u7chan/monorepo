/**
 * チャットから選択中セッションの作業フォルダを開くための root を決める。
 * 表示方法は layout ごとに変え、desktop は右パネル、compact は全画面シートを使う。
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
  compact: boolean;
  /** そのときの作成先。"" は未所属 */
  projectId: string;
};

/**
 * desktop のパネルの既定値。プロジェクト配下の新規会話だけ開にする。
 * 使うのは起動時の初期化と利用者操作の新規会話の入口だけで、派生 state (一覧の到着) を契機にしない。
 */
export function sessionFilesDefaultOpen({ compact, projectId }: SessionFilesDefaultOpen): boolean {
  return !compact && projectId !== "";
}
