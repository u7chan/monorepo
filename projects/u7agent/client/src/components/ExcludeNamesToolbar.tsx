import type { ExcludeNamesToolbarSettings } from "../hooks/useExcludeNamesSettings";
import { CheckIcon } from "./icons";
import { ReloadButton } from "./ReloadButton";

export type ExcludeNamesToolbarProps = {
  /** 編集している設定。どちらの画面も同じ操作と押せる条件を使う */
  settings: ExcludeNamesToolbarSettings;
};

/**
 * 「ダウンロードの除外」と「公開の除外」の操作帯。2 つの設定は別の行・別の既定を持つが、
 * 再読み込み・破棄・既定に戻す・保存と、それぞれを押せる条件は同じ。
 */
export function ExcludeNamesToolbar({ settings }: ExcludeNamesToolbarProps) {
  const { settings: loaded, dirty, saving, reloading, reload, save, reset, discard } = settings;
  return (
    <>
      {/* 再読み込みは下書きを捨てるので、変更がある間は押せない (理由の置き場は下の caption / context) */}
      <ReloadButton onClick={() => void reload()} disabled={dirty || reloading}>
        再読み込み
      </ReloadButton>
      <span aria-hidden="true" className="h-4 w-px bg-line" />
      <button type="button" className="btn-quiet" disabled={!dirty || saving} onClick={discard}>
        破棄
      </button>
      <button type="button" className="btn-quiet" disabled={!loaded?.overridden || saving} onClick={() => void reset()}>
        既定に戻す
      </button>
      <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
        <CheckIcon />
        保存
      </button>
    </>
  );
}
