/**
 * チャットから選択中セッションの作業フォルダを開くための root を決める。
 * 表示方法は layout ごとに変え、desktop は右パネル、compact は全画面シートを使う。
 */

export type SessionFilesAvailability = {
  /** チャット画面のときだけ出す。設定ページでは 設定 → ファイル と二重になるため出さない */
  chatView: boolean;
  /** 選択中セッションの作業フォルダ。未作成チャット (sessionId が空) では "" */
  cwd: string;
};

/** セッションファイルを出す root。"" は「出さない」を意味する */
export function sessionFilesRoot({ chatView, cwd }: SessionFilesAvailability): string {
  if (!chatView) return "";
  return cwd;
}
