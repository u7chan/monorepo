/**
 * bash の子プロセスの外向き TCP を、セッション単位の承認で制御する。モードは env で選び、承認は BFF の
 * メモリだけに置く (DB へ保存せず、会話をまたがない)。契約は docs/sandbox.md を正とする。
 *
 * 既定を `allow` にするのは後方互換のため。`ask` を既定にすると、承認の UI を持たない経路 (API 直叩き・
 * 旧クライアント) で `bash` の HTTPS が黙って止まる。
 */
import type { AskUserAnswer } from "./schema";

export type NetworkAccessMode = "allow" | "ask" | "deny";

export const NETWORK_ACCESS_MODE_ENV = "PI_SANDBOX_NETWORK_POLICY";

/**
 * env の値をモードへ解決する。未知の値は `allow` に倒す (設定ミスで通信を止めない)。
 * `deny` は承認しても開かない。`ask` だけが承認で開く。
 */
export function networkAccessMode(raw: string | undefined = process.env[NETWORK_ACCESS_MODE_ENV]): NetworkAccessMode {
  const value = raw?.trim().toLowerCase();
  return value === "ask" || value === "deny" ? value : "allow";
}

/**
 * セッション単位の承認。key は SDK のセッション id で、investigate の子は親と別の id を持つため
 * 親の承認を継承しない。値は真偽だけなので、失効時刻は持たない (会話を閉じるまで有効)。
 */
export class NetworkAccessApprovals {
  private readonly approved = new Set<string>();

  /** このセッションが 443 を開いてよいか。モードが `allow` なら常に真、`deny` なら常に偽 */
  allows(sessionId: string, mode: NetworkAccessMode = networkAccessMode()): boolean {
    if (mode === "allow") return true;
    if (mode === "deny") return false;
    return this.approved.has(sessionId);
  }

  approve(sessionId: string): void {
    this.approved.add(sessionId);
  }

  /** abort / 会話削除で未承認へ戻す。次の exec から閉じる */
  revoke(sessionId: string): void {
    this.approved.delete(sessionId);
  }

  /** 承認の可否。診断とテストが状態を読む */
  isApproved(sessionId: string): boolean {
    return this.approved.has(sessionId);
  }
}

/** 承認の回答から可否を取り出す。`approval` を持たない回答は未承認として扱う */
export function approvalOf(answer: AskUserAnswer | undefined): boolean {
  return answer?.approval === true;
}
