import { useCallback, useRef, useState, type RefObject } from "react";
import { DEFAULT_FILES_MODE, filesModeForTarget, filesModeScopeChanged, type FilesMode } from "../lib/fileRefRequest";
import type { FileRefTarget } from "../lib/fileRef";
import { sessionFilesDefaultOpen } from "../lib/sessionFiles";
import { nextSheetView, type SheetView } from "../lib/sheetView";
import { useExitPhase } from "./useExitPhase";
import type { ExitPhase } from "../lib/exitPhase";

export type UseSessionFilesFaceParams = {
  /** singleColumn はシート、desktop は右パネル (両方の state を持ち、layout で出し分ける) */
  singleColumn: boolean;
  /** 現在の画面。チャット以外へ移ると面を閉じる (設定 → ファイル と二重にしない) */
  view: string;
  /** 選択中の会話。切り替わると面を閉じ、モードを既定へ戻す */
  sessionId: string;
  /** 作業フォルダの root。"" は「面を出さない」 */
  root: string;
  /** 右パネルの退場アニメの対象 (main 列の要素) */
  panelRef: RefObject<HTMLElement | null>;
  /** ファイル参照の要求を面へ渡す (要求の寿命は選択中セッション) */
  requestFileRef: (target: FileRefTarget) => void;
};

export type SessionFilesFace = {
  /** desktop の右パネルが開いているか (root が無い / singleColumn では常に閉) */
  panelOpen: boolean;
  /** singleColumn のシートが開いているか (root が無い / desktop では常に閉) */
  sheetOpen: boolean;
  panelPhase: ExitPhase;
  sheetPhase: ExitPhase;
  /** シートの dialog 要素 (退場アニメの終端を待つ) */
  sheetRef: RefObject<HTMLDialogElement | null>;
  /** 面のモード (作業フォルダ / スキル) */
  mode: FilesMode;
  /** シートが今見せている面。退場中は動かさない (dialog の key と中身) */
  sheetView: SheetView;
  /** ファイル参照から開いたときの起点要素。シートを閉じたときにここへ focus を戻す */
  originRef: RefObject<HTMLElement | null>;
  /** バーのトグル。押した面だけを反転し、モードは既定へ戻す */
  toggle: () => void;
  closePanel: () => void;
  closeSheet: () => void;
  /** 面のモードだけを既定 (作業フォルダ) へ戻す */
  backToWork: () => void;
  /** 利用者操作の新規会話の入口。プロジェクト配下のときだけ desktop のパネルを開く */
  openForNewChat: (projectId: string) => void;
  /** 要求の種別へ面のモードを合わせてから開く (逆向きの参照も面が入れ替わって消費する) */
  openTarget: (target: FileRefTarget) => void;
};

/**
 * 作業フォルダの面と、その面ローカルの状態。開閉は保存せず起動時は閉。閉じる契機は前の描画の値と
 * 比べて描画中に同期する (`showModal()` は子の Effect が親より先に走り、1 フレーム開いたままになる)。
 */
export function useSessionFilesFace({
  singleColumn,
  view,
  sessionId,
  root,
  panelRef,
  requestFileRef,
}: UseSessionFilesFaceParams): SessionFilesFace {
  const [panelRequested, setPanelRequested] = useState(false);
  const [sheetRequested, setSheetRequested] = useState(false);
  // シートを閉じる契機の監視キー。route 全体は比べない (会話 URL の置換だけでは閉じない)
  const [sheetScope, setSheetScope] = useState(() => ({ singleColumn, view, root }));
  const sheetScopeChanged =
    sheetScope.singleColumn !== singleColumn || sheetScope.view !== view || sheetScope.root !== root;
  if (sheetScopeChanged) {
    setSheetScope({ singleColumn, view, root });
    setSheetRequested(false);
  }
  // 面のモード (作業フォルダ / スキル)。要求の種別で切り替え、閉じる導線 / セッション切替 / チャット以外への
  // 移動 / singleColumn ⇄ desktop の切替で既定 (作業フォルダ) へ戻す
  const [mode, setMode] = useState<FilesMode>(DEFAULT_FILES_MODE);
  // モードを既定へ戻す契機の監視キー。root (cwd) だけでは同一プロジェクトのセッション切替 / 新規チャットを
  // 拾えないため、選択中セッションの識別子も見る (シートの閉じと同じ描画中の同期で反映する)
  const [modeScope, setModeScope] = useState(() => ({ singleColumn, view, sessionId }));
  if (filesModeScopeChanged(modeScope, { singleColumn, view, sessionId })) {
    setModeScope({ singleColumn, view, sessionId });
    setMode(DEFAULT_FILES_MODE);
  }

  const panelOpen = !singleColumn && root !== "" && panelRequested;
  const sheetOpen = singleColumn && root !== "" && sheetRequested;
  const sheetRef = useRef<HTMLDialogElement | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  // 開閉の phase。閉じた後も退場アニメの間だけ mount を延ばし、CSS の再生と state の寿命を合わせる (hooks/useExitPhase)
  const panelPhase = useExitPhase(panelOpen, panelRef);
  const sheetPhase = useExitPhase(sheetOpen, sheetRef);
  // 退場中はシートの見え方を固定する。key (root) が動くと dialog が作り直され、退場アニメが途中で切れる
  // (終了待ちの listener が外れた要素に残り、スライド中に中身も入れ替わる)。追従させる条件は lib/sheetView.ts
  const [sheetView, setSheetView] = useState<SheetView>(() => ({ root, mode }));
  const nextView = nextSheetView(sheetView, { root, mode }, sheetOpen, sheetScopeChanged);
  if (nextView !== null) setSheetView(nextView);

  const backToWork = useCallback(() => setMode(DEFAULT_FILES_MODE), []);
  const toggle = useCallback(() => {
    // トグルからの開閉ではファイル参照へ focus を戻さない
    originRef.current = null;
    // 閉じる導線は面ごと既定 (作業フォルダ面) へ戻す (開き直してもスキル面を残さない)
    setMode(DEFAULT_FILES_MODE);
    // 押した面 (layout で決まる) だけを反転する
    if (singleColumn) setSheetRequested((open) => !open);
    else setPanelRequested((open) => !open);
  }, [singleColumn]);
  // 閉じる導線は押した面だけを閉じる。特にシートの close で desktop のパネルを閉じると、
  // singleColumn を往復しただけで開閉が変わる (レイアウト切替は互いの state に影響しない)
  const closePanel = useCallback(() => {
    setPanelRequested(false);
    setMode(DEFAULT_FILES_MODE);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetRequested(false);
    setMode(DEFAULT_FILES_MODE);
  }, []);
  const openForNewChat = useCallback(
    (projectId: string) => {
      setPanelRequested(sessionFilesDefaultOpen({ singleColumn, projectId }));
    },
    [singleColumn],
  );
  const openTarget = useCallback(
    (target: FileRefTarget) => {
      setMode(filesModeForTarget(target));
      if (singleColumn) setSheetRequested(true);
      else setPanelRequested(true);
      requestFileRef(target);
    },
    [singleColumn, requestFileRef],
  );

  return {
    panelOpen,
    sheetOpen,
    panelPhase,
    sheetPhase,
    sheetRef,
    mode,
    sheetView,
    originRef,
    toggle,
    closePanel,
    closeSheet,
    backToWork,
    openForNewChat,
    openTarget,
  };
}
