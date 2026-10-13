/**
 * 設定 → スペースの削除の成功後処理。`DELETE` を待つ間も行の選択は動き得るため、移り先の判定は
 * 呼び出し時点ではなく**成功時点**の選択で行う。後着の応答が新しい選択を巻き戻すと、選択したばかりの
 * スペースの subtree を捨てたり、削除済みの ID を保存値に残して復旧画面にしたりするため
 * (docs/frontend.md#スペースの選択)。
 *
 * 選択を変えると `App` が作り直され、その時点の URL が画面になる。会話を持たない chat への導線は
 * 選択の更新より先に呼び、URL を確定させてから作り直す。
 */
import { selectionAfterSpaceDelete } from "./spaceSelection";

export type SpaceDeleteDeps = {
  /** 削除要求。失敗はそのまま投げる (画面が理由を出す) */
  removeSpace: (id: string) => Promise<unknown>;
  /** 成功時点の選択 ID。呼び出しごとに読む (呼び出し時の値を閉じ込めない) */
  selectedId: () => string;
  /** 一覧からその行を外す */
  forget: (id: string) => void;
  /** 以下は選択中のスペースを消したときだけ、この順で呼ぶ */
  navigateToChat: () => void;
  persistSelection: (id: string) => void;
  select: (id: string) => void;
};

/** 削除して、選択中のスペースだったときだけ既定スペースへ切り替える。`selectionReset` はその判定 */
export async function removeSpaceAndApply(id: string, deps: SpaceDeleteDeps): Promise<{ selectionReset: boolean }> {
  await deps.removeSpace(id);
  deps.forget(id);
  const nextSelection = selectionAfterSpaceDelete(deps.selectedId(), id);
  if (nextSelection === null) return { selectionReset: false };
  deps.navigateToChat();
  deps.persistSelection(nextSelection);
  deps.select(nextSelection);
  return { selectionReset: true };
}
