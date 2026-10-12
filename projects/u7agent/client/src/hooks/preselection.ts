/**
 * 未作成チャットの Model / Effort の先行選択。値と世代を組で読ませるために factory にする
 * (React の state だけでは、作成の応答待ちに選び直されたかを判定できない)。
 */
import type { SettingsSelection } from "./settingsChange";

export type PreselectionRequest = { selection: SettingsSelection; generation: number };

export type Preselection = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => SettingsSelection;
  update: (selection: SettingsSelection) => void;
  beginCreate: () => PreselectionRequest;
  consume: (generation: number) => void;
  reset: () => void;
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
