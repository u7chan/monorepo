import { useCallback, useRef, useState, type RefObject } from "react";
import {
  canResizeSessionFilesPanel,
  sessionFilesPanelBounds,
  sessionFilesPanelWidth,
  sessionFilesPanelWidthStore,
} from "../lib/sessionFilesPanel";

/** 幅を選ぶハンドル (SessionFilesPanel) が使う値と操作 */
export type SessionFilesPanelResize = {
  /** 表示幅 (clamp 済み)。main の CSS 変数 --session-files-width に渡す */
  width: number;
  min: number;
  max: number;
  /** min == max の幅ではハンドルを出さない */
  resizable: boolean;
  /**
   * ドラッグ中の追従。state を動かさず main の CSS 変数だけを書き換える (右パネルは FileBrowser の
   * ツリーとハイライトを含み、move ごとの再描画が重い)。clamp は呼び出し側で済ませておく。
   */
  preview(width: number): void;
  /** 確定。state と保存値を更新する (ドラッグの終了 / キーボード操作) */
  commit(width: number): void;
  /** 未指定 (既定幅 = 最小幅) へ戻し、保存を消す */
  reset(): void;
};

export type SessionFilesPanelWidth = SessionFilesPanelResize & {
  /** main へ渡す ref。preview はここへ CSS 変数を直接書く */
  mainRef: RefObject<HTMLElement | null>;
};

export type SessionFilesPanelWidthInput = {
  /** viewport の幅 (useViewportWidth)。bounds の 30vw 側の根拠 */
  viewportWidth: number;
  /** 左バーを引いた main 列の幅。左バーの配置が変われば呼び出し側が選び直す */
  mainWidth: number;
};

/**
 * 右パネルの幅。state は「ユーザーが示した希望幅」(clamp 前) で、表示幅は bounds で clamp する
 * (狭い窓で選んでも、広げ直したときに選んだ幅へ戻せる)。
 */
export function useSessionFilesPanelWidth({
  viewportWidth,
  mainWidth,
}: SessionFilesPanelWidthInput): SessionFilesPanelWidth {
  const [requested, setRequested] = useState<number | null>(() => sessionFilesPanelWidthStore.read());
  const mainRef = useRef<HTMLElement | null>(null);
  const bounds = sessionFilesPanelBounds(viewportWidth, mainWidth);
  const width = sessionFilesPanelWidth(requested, bounds);

  // 依存を空にして identity を固定する (ハンドルのアンマウント時の後始末がこれに乗っている)
  const preview = useCallback((next: number) => {
    mainRef.current?.style.setProperty("--session-files-width", `${next}px`);
  }, []);

  const commit = useCallback((next: number) => {
    setRequested(next);
    sessionFilesPanelWidthStore.write(next);
  }, []);

  const reset = useCallback(() => {
    setRequested(null);
    sessionFilesPanelWidthStore.write(null);
  }, []);

  return {
    mainRef,
    width,
    min: bounds.min,
    max: bounds.max,
    resizable: canResizeSessionFilesPanel(bounds),
    preview,
    commit,
    reset,
  };
}
