/**
 * 設定 → モデル「プロバイダー」タブの表示状態。カスタムプロバイダーの追加フォームと provider 詳細は
 * 排他で、どちらを開くかを 1 つの状態で決める (別々の真偽値だと片方だけ閉じ忘れる)。
 * 切替は SSR で観測できないため、遷移を純関数にして固定する。
 */
export interface ProviderTabView {
  /** 選んだ行のキー (provider:<id> / custom:<id>)。null なら既定の行を開く */
  selectedKey: string | null;
  /** カスタムプロバイダーの追加フォームを開いているか */
  addingCustom: boolean;
}

export type ProviderTabAction =
  /** 一覧の行を選ぶ。追加フォームが開いていれば閉じ、その行の詳細を開く */
  | { type: "select-row"; key: string }
  /** 追加フォームを開く。provider 詳細は閉じる */
  | { type: "start-add" }
  /** 追加フォームを閉じる / 選択を解除して既定の provider 詳細へ戻す。下書きは破棄する */
  | { type: "reset" };

export const PROVIDER_TAB_INITIAL_VIEW: ProviderTabView = { selectedKey: null, addingCustom: false };

export function providerTabView(current: ProviderTabView, action: ProviderTabAction): ProviderTabView {
  const next: ProviderTabView =
    action.type === "select-row"
      ? { selectedKey: action.key, addingCustom: false }
      : action.type === "start-add"
        ? { selectedKey: null, addingCustom: true }
        : PROVIDER_TAB_INITIAL_VIEW;
  // 同じ状態なら作り直さない (選択中の行を押し直したときに詳細ペインを再マウントさせない)
  return next.selectedKey === current.selectedKey && next.addingCustom === current.addingCustom ? current : next;
}
