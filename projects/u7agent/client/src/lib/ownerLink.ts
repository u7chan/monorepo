/**
 * 設定 → ランタイムの「起動元の会話」リンク (通常クリック) の行き先。所属が分かる別スペースなら、
 * 会話を URL に載せてからそのスペースを選び直す (切替は App ごと作り直すため、順序を入れ替えない)。
 */
import type { Space } from "server";
import type { Route } from "./route";
import { ownerLinkSpace } from "./spaceSelection";

export type OwnerLinkDeps = {
  spaces: Space[];
  currentSpaceId: string;
  /** 会話を URL に載せる。新しい App の入口解決 (`/s/<id>`) が開く */
  navigate: (route: Route) => void;
  selectSpace: (spaceId: string) => void;
  /** 現在のスペースで開く (開けないときの未選択チャットへの移り先は呼び出し側が持つ) */
  openInPlace: (sessionId: string) => void;
};

export function openOwnerSession(sessionId: string, spaceId: string | undefined, deps: OwnerLinkDeps): void {
  const switchTo = ownerLinkSpace(spaceId, deps.currentSpaceId, deps.spaces);
  if (!switchTo) {
    deps.openInPlace(sessionId);
    return;
  }
  deps.navigate({ view: "chat", sessionId });
  deps.selectSpace(switchTo);
}
