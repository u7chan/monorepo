import { ReloadButton } from "../ReloadButton";

/**
 * 上流 (OpenRouter / コストマスタ) から一覧と価格を取り直す 1 操作。押しても画面の値は変わらず、
 * 取りに行った結果で一覧と価格が入れ替わるため、帯ではなく「一覧の出どころ」を書いている行に置く
 * (帯の [再読み込み] はサーバーが持つ現在値で表示を作り直すだけで、対象が違う)。
 * 印は取り直しと同じ ↻ を使う: 同じ印の操作を 1 つにまとめる規則は `ReloadButton` が持つ。
 * 置き場所で役割を分けているため、帯と並べると同じことをする 2 つの入口に見える。
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
