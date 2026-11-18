import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import {
  CUSTOM_PROVIDER_PROBE_LABEL,
  CUSTOM_PROVIDER_PROBE_PENDING_LABEL,
  filterModelIds,
} from "../../lib/customProviders";
import { popoverLeft, popoverTop, popoverWidth } from "../../lib/popoverPlacement";
import { POPOVER_MARGIN } from "../../lib/popoverPlacement";
import { selectMenuPlacement } from "../../lib/selectMenu";
import { usePopoverShell, type PopoverPlaceInput } from "../../hooks/usePopoverShell";
import { CheckIcon } from "../icons";

const MIN_WIDTH = 260;

export type ModelIdPickerProps = {
  /** 現在のモデル ID。一覧の選択状態にだけ使う (入力欄の正は親) */
  value: string;
  /** 取得中。押下中はラベルを変えて無効にする */
  loading: boolean;
  disabled: boolean;
  /**
   * 一覧を取りに行く。キャッシュが新しければ親がそれを返し、失敗時は空配列を返す
   * (エラーの表示は親の結果行が持つ)。reject しない契約。
   */
  onRequest: () => Promise<readonly string[]>;
  onPick: (id: string) => void;
};

/**
 * カスタムプロバイダーのモデル ID 選択。押したときに `/models` の一覧を取り、
 * 検索付きの popover で 1 件選ぶ。入力欄は自由入力のままなので、一覧に無い ID も使える。
 * 開閉と配置の作法は SelectMenu / ModelDefaultPicker に揃える。
 */
export function ModelIdPicker({ value, loading, disabled, onRequest, onPick }: ModelIdPickerProps) {
  const pickerId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [ids, setIds] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const requesting = useRef(false);
  const choices = filterModelIds(ids, query);

  // 幅と一覧の高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
  const sizePicker = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    popover.style.width = `${popoverWidth(Math.max(anchor.width, MIN_WIDTH), viewport.width)}px`;
    const list = listRef.current;
    if (list !== null) {
      // 検索欄と一覧の外枠の高さを引いた分だけを一覧のスクロールに当てる
      const { maxHeight } = selectMenuPlacement(anchor, viewport.height);
      const chrome = popover.getBoundingClientRect().height - list.getBoundingClientRect().height;
      list.style.maxHeight = `${Math.max(0, maxHeight - chrome)}px`;
    }
  }, []);

  const place = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    const anchor = trigger.getBoundingClientRect();
    const width = popoverWidth(Math.max(anchor.width, MIN_WIDTH), viewport.width);
    const { above } = selectMenuPlacement(anchor, viewport.height);
    return {
      left: popoverLeft(anchor, width, viewport.width),
      top: popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height),
    };
  }, []);

  // 開いた直後は検索欄へ入る (自由入力の欄なので、一覧を辿るより打つ方が速い)
  const { triggerProps, popoverProps, exitProps, itemRef, isOpen, open, close } = usePopoverShell(
    place,
    POPOVER_MARGIN,
    ({ place: placeNow }) => placeNow(),
    ({ close: closeNow }) => closeNow(),
    sizePicker,
    () => searchRef.current,
  );

  /** 一覧を取り直してから開く。取得中は押しても開かない (二重の要求を出さない) */
  const requestAndOpen = async () => {
    if (disabled || loading || requesting.current) return;
    requesting.current = true;
    try {
      const next = await onRequest();
      if (next.length === 0) return;
      setIds(next);
      setQuery("");
      open();
    } finally {
      requesting.current = false;
    }
  };

  const toggle = () => {
    if (isOpen) close();
    else void requestAndOpen();
  };

  /** 検索欄のキー。Enter は外側の登録フォームを送信させない (↑↓ は hook が一覧へ抜ける) */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
  };

  const select = (id: string) => {
    close();
    onPick(id);
  };

  return (
    <span className="contents" {...exitProps}>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="listbox"
        aria-controls={pickerId}
        aria-label={CUSTOM_PROVIDER_PROBE_LABEL}
        disabled={disabled || loading}
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          // 既定のスクロールを止める。取得は click と同じ経路に任せ、開いたら検索へ焦点を移す
          event.preventDefault();
          toggle();
        }}
        className="btn-quiet min-h-8 shrink-0 whitespace-nowrap"
      >
        {loading ? CUSTOM_PROVIDER_PROBE_PENDING_LABEL : CUSTOM_PROVIDER_PROBE_LABEL}
      </button>

      <div
        {...popoverProps}
        id={pickerId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        <div className="border-b border-line p-1.5">
          <input
            ref={searchRef}
            type="search"
            className="field min-w-0 text-xs"
            value={query}
            placeholder="モデル ID で絞り込み"
            aria-label="モデル ID を絞り込む"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {choices.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-ink-muted singleColumn:text-xs">該当するモデルがありません。</p>
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-label="モデル一覧"
          className={cn(
            "grid scrollbar-thin overflow-x-hidden overflow-y-auto p-1 singleColumn:p-2",
            choices.length === 0 && "hidden",
          )}
        >
          {choices.map((id, index) => (
            <button
              key={id}
              ref={itemRef(index)}
              type="button"
              role="option"
              aria-selected={id === value}
              tabIndex={-1}
              onClick={() => select(id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors singleColumn:min-h-11",
                id === value ? "bg-accent-wash" : "hover:bg-accent-wash",
              )}
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink singleColumn:text-sm">{id}</code>
              {id === value ? (
                <span className="shrink-0 text-accent-text">
                  <CheckIcon />
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="border-t border-line px-2.5 py-1.5 text-2xs leading-relaxed text-ink-muted">
          選ぶとモデル ID の欄に入ります。この一覧に無い ID も直接入力できます。
        </p>
      </div>
    </span>
  );
}
