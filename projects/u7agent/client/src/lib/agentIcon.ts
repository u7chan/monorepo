import type { AgentDef } from "../types";

/** アイコンの箱 (px)。server の上限と合わせ、client はこの箱へ縮小してから送る */
export const AGENT_ICON_BOX = 256;

/** 生バイトの上限。server (agents.ts の ICON_MAX_BYTES) と同じ値で、超える値は描画しない */
const ICON_MAX_BYTES = 16 * 1024;

/** server が受理する data URL だけを表示に使う (形式違い・壊れた値は SparkleIcon へ落とす) */
const ICON_DATA_URL = /^data:image\/(?:webp|png);base64,([A-Za-z0-9+/]+={0,2})$/;

/** 正規の base64 は 4 の倍数。端数がある値は server も受理しないため、表示にも使わない */
function isCanonicalBase64(payload: string): boolean {
  return payload.length % 4 === 0;
}

/** base64 の文字数からデコード後のバイト数を出す (atob を使わず、Node のテストでも同じ結果にする) */
function base64Bytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

/** 表示できるアイコンか。未設定・形式違い・上限超えは false */
export function isAgentIcon(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ICON_DATA_URL.exec(value);
  return match !== null && isCanonicalBase64(match[1]) && base64Bytes(match[1]) <= ICON_MAX_BYTES;
}

/**
 * 箱に収める縮小サイズ。アスペクト比を保ち、拡大はしない (元が小さい画像はそのまま)。
 * 縮小側は箱で頭打ちにして、丸めで箱を超えないようにする。
 */
export function fitIconSize(width: number, height: number, box = AGENT_ICON_BOX): { width: number; height: number } {
  const sourceWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const sourceHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
  const scale = Math.min(1, box / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.min(box, Math.max(1, Math.round(sourceWidth * scale))),
    height: Math.min(box, Math.max(1, Math.round(sourceHeight * scale))),
  };
}

/**
 * カタログから agentId のアイコンを引く。定義が消えたセッションや未設定は undefined になり、
 * 表示側は SparkleIcon へフォールバックする (名前はセッションのスナップショットを使う)。
 */
export function agentIconOf(agents: AgentDef[], agentId: string | undefined): string | undefined {
  const icon = agents.find((agent) => agent.id === agentId)?.icon;
  return isAgentIcon(icon) ? icon : undefined;
}
