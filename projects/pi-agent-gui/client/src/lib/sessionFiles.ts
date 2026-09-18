/**
 * チャットの右パネル (セッションのファイル) の出し方の規則。パネルは選択中セッションの作業フォルダ
 * (`SessionPayload.cwd` = `.pi-agent-gui/sessions/<id>`) を root にした `FileBrowser` で、
 * 設定 → ファイル (ワークスペース root 固定) と同じ実装を別の root で使う。DOM に依存しない。
 */

export type SessionFilesAvailability = {
  /** desktop shell のときだけ出す (compact は設定 → ファイル の 1 経路に保つ) */
  desktop: boolean;
  /** チャット画面のときだけ出す。設定ページでは 設定 → ファイル と二重になり、トグルも押せない */
  chatView: boolean;
  /** 選択中セッションの作業フォルダ。未作成チャット (sessionId が空) では "" */
  cwd: string;
};

/** パネルを出す root。"" は「出さない」を意味する (パネルの root が空にならないため) */
export function sessionFilesRoot({ desktop, chatView, cwd }: SessionFilesAvailability): string {
  if (!desktop || !chatView) return "";
  return cwd;
}
