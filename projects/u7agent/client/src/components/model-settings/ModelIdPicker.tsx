import { useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  CUSTOM_PROVIDER_PROBE_LABEL,
  CUSTOM_PROVIDER_PROBE_PENDING_LABEL,
  filterModelIds,
} from "../../lib/customProviders";
import { POPOVER_MARGIN } from "../../lib/popoverPlacement";
import { usePopoverShell } from "../../hooks/usePopoverShell";
import { useSearchableSelectMenu } from "../../hooks/useSearchableSelectMenu";
import { CheckIcon } from "../icons";

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
 * カスタムプロバイダーのモデル ID 選択。押したときに `/models` を取って検索付きの popover で選ぶ。
 * 入力欄は自由入力のままなので一覧に無い ID も使える (開閉と配置は SelectMenu に揃える)。
 */
export function ModelIdPicker({ value, loading, disabled, onRequest, onPick }: ModelIdPickerProps) {
  const pickerId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [ids, setIds] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const requesting = useRef(false);
  const choices = filterModelIds(ids, query);

  // 検索欄と一覧の外枠の高さを引いた分だけを一覧のスクロールに当てる
  const chrome = ({ popover, list }: { popover: HTMLElement; list: HTMLElement }) =>
    popover.getBoundingClientRect().height - list.getBoundingClientRect().height;
  const {
    listRef,
    size: sizePicker,
    place,
    onSearchKeyDown,
  } = useSearchableSelectMenu({
    value,
    values: choices,
    chrome,
  });

  // 開いた直後は検索欄へ入る (自由入力の欄なので、一覧を辿るより打つ方が速い)
  const { triggerProps, popoverProps, exitProps, itemRef, isOpen, open, close } = usePopoverShell(
    place,
    POPOVER_MARGIN,
    {
      reposition: ({ place: placeNow }) => placeNow(),
      exitOnBlur: ({ close: closeNow }) => closeNow(),
      size: sizePicker,
      openOnArrowKeys: true,
      openFocus: () => searchRef.current,
    },
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
