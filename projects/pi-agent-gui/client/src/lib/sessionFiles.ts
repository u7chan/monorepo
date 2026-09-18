/**
 * チャットの右パネル (セッションのファイル) の規則。パネルは選択中セッションの作業フォルダ
 * (`SessionPayload.cwd` = `.pi-agent-gui/sessions/<id>`) を root にした `FileBrowser` で、
 * 設定 → ファイル (ワークスペース root 固定) と同じ実装を別の root で使う。DOM に依存しない。
 */
import type { RunStatus } from "../types";

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

/**
 * run_end による読み直しの判定。実行中の間はファイルが書き変わり続けるため、`running` を抜けた
 * 瞬間だけを終了とみなす (次のメッセージが待機していても `queued` になった時点で 1 回読み直す)。
 * 同じ値のまま (mount 直後) では撃たない。
 */
export function isRunEnd(previous: RunStatus, next: RunStatus): boolean {
  return previous === "running" && next !== "running";
}
