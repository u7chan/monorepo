import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_FILE_ICON_STYLE, fileIconStyleStore, type FileIconStyle } from "../lib/fileIconStyle";

/** 保存値が無い環境 (テスト / サーバー描画) の初期値。既定と同じなので、初回描画で見た目が動かない */
const serverSnapshot = () => DEFAULT_FILE_ICON_STYLE;

/** ツリーのアイコンの見た目。設定画面で選び直すと同じ画面のツリーにも反映する */
export function useFileIconStyle(): FileIconStyle {
  return useSyncExternalStore(fileIconStyleStore.subscribe, fileIconStyleStore.read, serverSnapshot);
}

/** 設定画面 (外観 → アイコン) が使う値と操作 */
export function useFileIconStyleSetting(): {
  style: FileIconStyle;
  setStyle: (style: FileIconStyle) => void;
} {
  const style = useFileIconStyle();
  const setStyle = useCallback((next: FileIconStyle) => fileIconStyleStore.write(next), []);
  return { style, setStyle };
}
