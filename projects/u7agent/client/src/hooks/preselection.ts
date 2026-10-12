/**
 * 未作成チャットの Model / Effort の先行選択。セッション未作成の間だけ持ち、最初の送信で作られる
 * セッションの初期値になる。手動選択を未送信チャットの寿命に閉じるため、新しいチャットを開いたときと
 * 選択中エージェントが変わったときに捨て、作成の応答による消費は要求時に読んだ世代に閉じる
 * (応答待ちに別のチャットへ移って選び直した値を、遅れて届いた応答が消さない。通知の先行選択と同じ形)。
 */
import type { SettingsSelection } from "./settingsChange";

/** 作成の要求へ載せる先行選択と、その時点の世代 */
export type PreselectionRequest = { selection: SettingsSelection; generation: number };

export type Preselection = {
  /** useSyncExternalStore の購読 */
  subscribe: (listener: () => void) => () => void;
  /** 未作成チャットの選択 (画面の表示用)。変更が無ければ同じ参照を返す */
  snapshot: () => SettingsSelection;
  /** 未作成チャットの選択をフィールド単位で更新する */
  update: (selection: SettingsSelection) => void;
  /** 作成の要求へ載せる値を読む。応答の適用時に consume へ世代を渡す */
  beginCreate: () => PreselectionRequest;
  /** 作成の完了で消費する。世代が変わっていたら (切替 / 選び直しの後) いまの選択を消さない */
  consume: (generation: number) => void;
  /** 新しいチャットを開いたときに捨てる。進行中の作成があっても、その応答で消させない */
  reset: () => void;
  /** 選択中エージェントの変更に追随する。同じ ID の再取得では捨てない */
  syncAgent: (agentId: string) => void;
};

const isEmpty = (selection: SettingsSelection): boolean =>
  selection.model === undefined && selection.thinkingLevel === undefined;

export function createPreselection(): Preselection {
  let selection: SettingsSelection = {};
  let generation = 0;
  let agentId = "";
  let agentKnown = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const clear = () => {
    if (isEmpty(selection)) return;
    selection = {};
    emit();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => selection,
    update(next: SettingsSelection): void {
      const merged = { ...selection, ...next };
      if (merged.model === selection.model && merged.thinkingLevel === selection.thinkingLevel) return;
      selection = merged;
      generation += 1;
      emit();
    },
    beginCreate: () => ({ selection, generation }),
    consume(consumed: number): void {
      if (generation !== consumed) return;
      clear();
    },
    reset(): void {
      generation += 1;
      clear();
    },
    syncAgent(next: string): void {
      if (!agentKnown) {
        agentKnown = true;
        agentId = next;
        return;
      }
      if (agentId === next) return;
      agentId = next;
      generation += 1;
      clear();
    },
  };
}
