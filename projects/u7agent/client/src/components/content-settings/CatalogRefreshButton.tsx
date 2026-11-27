import { ReloadButton } from "../ReloadButton";

/**
 * 上流から一覧と価格を取り直す 1 操作。押しても画面の値は変わらず結果で入れ替わるため、帯ではなく
 * 「一覧の出どころ」の行に置く (帯の [再読み込み] とは対象が違う。印は ReloadButton と同じ)。
 */
export function CatalogRefreshButton({
  refreshing,
  disabled,
  onClick,
}: {
  /** この操作の実行中。ラベルを [更新中] にし、押し直せないようにする */
  refreshing: boolean;
  /** 別の保存の実行中。一覧が入れ替わると保存の対象が変わるため、重ねない */
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <ReloadButton size="sm" onClick={onClick} disabled={disabled || refreshing}>
      {refreshing ? "更新中" : "カタログ更新"}
    </ReloadButton>
  );
}
