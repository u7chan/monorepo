import { useEffect, useRef, useState, type RefObject } from "react";

/** 一覧と詳細のどちらを見せるか。並列表示では使わない */
export type ListDetailView = "list" | "detail";

export type ListDetailPaneOptions = {
  /** 一覧と詳細を並べて出す (900px 以上の desktop)。並べている間は面の切り替えが起きない */
  split: boolean;
  /** 一覧へ戻ったときに焦点を当てる行の id。未選択は null で、一覧の先頭のボタンへ落とす */
  selectedId: string | null;
  /** 行が id を持つ属性 (`data-agent-row` / `data-prompt-row` / `data-skill-row`) */
  rowAttribute: string;
};

export type ListDetailPane = {
  view: ListDetailView;
  /** 詳細を開く。並べて見せている間は切り替えない (一覧の行が切り替えを担う) */
  openDetail: () => void;
  /** 一覧へ戻る。並べて見せている間は切り替えない */
  backToList: () => void;
  /** 一覧の面。隠れている間も mount したままにする容器に付ける */
  listRef: RefObject<HTMLDivElement | null>;
  /** 詳細の見出し (`SettingsDetailHeader`)。フォーカスを受ける */
  detailRef: RefObject<HTMLDivElement | null>;
};

/**
 * 設定ページの「一覧 ⇄ 詳細」の面・焦点・Escape。並べて見せないとき (singleColumn / 狭い desktop /
 * 低い窓) だけ切り替わり、焦点は詳細では見出しへ、戻ったときは選択中の行へ移す
 * (docs/ui-layout.md の「設定の一覧と編集の境界」)。行の特定は呼び出し側が `rowAttribute` で渡す。
 */
export function useListDetailPane({ split, selectedId, rowAttribute }: ListDetailPaneOptions): ListDetailPane {
  const [view, setView] = useState<ListDetailView>("list");
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // 面を切り替えたときだけ焦点を移す。並べている間は一覧と詳細が同時に見えているので動かさない
  const previousView = useRef<ListDetailView>(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (split || previous === view) return;
    if (view === "detail") {
      detailRef.current?.focus();
      return;
    }
    const row = selectedId
      ? listRef.current?.querySelector<HTMLButtonElement>(`[${rowAttribute}="${CSS.escape(selectedId)}"] button`)
      : undefined;
    (row ?? listRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [view, split, selectedId, rowAttribute]);

  // 詳細の Escape は一覧へ戻す。capture で受けるのは、焦点が詳細の外へ落ちていても
  // App の「設定 → チャット」の Escape (window の bubble) より先に消費するため
  useEffect(() => {
    if (split || view !== "detail") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // モーダル / popover が開いている間は、そちらの標準の閉じ方に任せる
      if (document.querySelector("dialog[open], :popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      setView("list");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [split, view]);

  return {
    view,
    // 並べている間は一覧と詳細が同時に見えているので切り替えない。状態も動かさない: 狭めたときに、
    // 広い窓でした操作（保存の完了など）のせいで面が変わるのを避ける
    openDetail: () => {
      if (!split) setView("detail");
    },
    backToList: () => {
      if (!split) setView("list");
    },
    listRef,
    detailRef,
  };
}
