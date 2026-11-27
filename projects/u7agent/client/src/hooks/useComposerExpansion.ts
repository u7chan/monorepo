import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { composerFocusAfterSend, hasCoarsePointer } from "../lib/composerFocus";
import type { ExitPhase } from "../lib/exitPhase";
import type { LayoutMode } from "../lib/layout";
import { useExitPhase } from "./useExitPhase";

export type ComposerExpansionOptions = {
  /** 拡大した面の入力欄。開くときの焦点と、送信で畳んだ後の焦点の戻し先 */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 送信の成立。拡大のまま応答を待たないよう畳む */
  sending: boolean;
  /** 非表示 (設定ページ) の間は畳む。dialog は top layer へ移るため、開いたままだと隠れた (inert な) 面に modal だけが残る */
  visible: boolean;
  /** 切り替わったら畳む (面の寸法と余白が別物になる) */
  mode: LayoutMode;
};

export type ComposerExpansion = {
  /** 外装の dialog。native の showModal / close に任せる */
  dialogRef: RefObject<HTMLDialogElement | null>;
  expanded: boolean;
  /** 見た目の面を拡大側へ切り替える条件。退場アニメの間も拡大の寸法を保つ */
  expandedUi: boolean;
  /** 退場アニメの phase。dialog の `data-closing` に出す */
  expandPhase: ExitPhase;
  toggle: () => void;
  /** dialog の cancel (Escape)。自分の dialog の分だけを受ける */
  cancel: (event: SyntheticEvent<HTMLDialogElement>) => void;
  /** 背景 (dialog 自身) のクリックだけを閉じる要求にする */
  backdropClick: (event: MouseEvent<HTMLDialogElement>) => void;
  /** 余白の押下で外装の dialog に焦点を移さない */
  backdropPointerDown: (event: PointerEvent<HTMLDialogElement>) => void;
};

/**
 * 入力欄の拡大表示。外装は native の dialog で、開閉・焦点・退場アニメの寿命だけを持つ。
 * 退場アニメの間だけ dialog を開いたままにする (閉じる前に拡大の位置から消えないようにする)。
 */
export function useComposerExpansion({
  inputRef,
  sending,
  visible,
  mode,
}: ComposerExpansionOptions): ComposerExpansion {
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // 送信で畳んだか (close() の後に、送信後の焦点の規則で焦点を決め直す根拠)
  const collapsedBySendRef = useRef(false);
  const expandPhase = useExitPhase(expanded, dialogRef);
  const expandedUi = expanded || expandPhase === "closing";

  // 拡大の開閉は native の showModal / close に任せる (背景の操作を止める・Escape・焦点の復帰が標準で付く)。
  // close を layout effect に置くのは、退場アニメの終了と同じ描画で閉じるため (1 フレーム拡大のまま残らない)
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (expanded && !dialog.open) {
      /**
       * showModal() は先頭の操作要素へ焦点を移すため、そのまま開くと本文の IME の変換中が blur で切れる。
       * 開く間だけ本文へ autofocus を付け、焦点移動の理由ごと無くす (目的は書き続けること)。
       */
      const textarea = inputRef.current;
      textarea?.setAttribute("autofocus", "");
      dialog.showModal();
      textarea?.removeAttribute("autofocus");
      textarea?.focus();
    } else if (!expanded && expandPhase === "closed" && dialog.open) {
      dialog.close();
      // close() は「開く前に焦点があった要素」(拡大のボタン) へ**同期で**戻す。送信で畳むときは、送信後の
      // 焦点の規則 (fine は本文 / coarse は外す。docs/ui-layout.md) をその後に適用し直す
      if (collapsedBySendRef.current) {
        collapsedBySendRef.current = false;
        if (composerFocusAfterSend(hasCoarsePointer()) === "focus") inputRef.current?.focus();
      }
    }
  }, [expanded, expandPhase, inputRef]);

  // 送信したら畳む (拡大のまま残すと、応答が見えない位置で書き続けることになる)。畳んだ後に焦点を決め直す印は
  // この時点の `expanded` で立てる (`sending` を後から読むと、run が先に終わっていて落ちる)
  useEffect(() => {
    if (!sending) return;
    if (expanded) collapsedBySendRef.current = true;
    setExpanded(false);
  }, [sending]);

  /**
   * 退場アニメの間の Escape は自分で消費する。2 回目の cancel は cancelable: false で止められず、
   * UA が即座に閉じると全画面の寸法のまま戻るため、keydown の既定動作ごと止める (設定へ移るときは通す)。
   */
  useEffect(() => {
    if (expandPhase !== "closing" || !visible) return;
    const onKeyDown = (event: WindowEventMap["keydown"]) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expandPhase, visible]);

  // チャット以外へ移る / レイアウトが切り替わるときは畳む
  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  useEffect(() => {
    setExpanded(false);
  }, [mode]);

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  // Escape は dialog の標準の閉じ方 (cancel) で受ける
  const cancel = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    // 添付画像の拡大 (portal の dialog) の cancel も React のツリーを伝わって届く。自分の dialog の分だけを受け、
    // 開いてもいない面を閉じない (event をそのまま通せば、画像側が標準どおり閉じる)
    if (event.target !== event.currentTarget) return;
    // 退場アニメの間 (expanded が false) も既定動作を止める。止めると、全画面の寸法のまま通常フローへ戻る
    // 1 フレームが出る (実際の close() は phase が closed になった経路だけ)
    event.preventDefault();
    setExpanded(false);
  }, []);

  const backdropClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      // 中央の箱の中のクリックは含めない
      if (!expanded || event.target !== dialogRef.current) return;
      setExpanded(false);
    },
    [expanded],
  );

  // 移ると画面幅いっぱいの輪郭が入力欄の上下に出るため、外装の余白では焦点を移さない
  const backdropPointerDown = useCallback((event: PointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
  }, []);

  return {
    dialogRef,
    expanded,
    expandedUi,
    expandPhase,
    toggle,
    cancel,
    backdropClick,
    backdropPointerDown,
  };
}
