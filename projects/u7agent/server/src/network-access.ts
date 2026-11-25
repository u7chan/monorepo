/**
 * bash の子プロセスの外向き TCP を、セッション単位の承認で制御する。モードは env で選び、承認は BFF の
 * メモリだけに置く (DB へ保存せず、会話をまたがない)。契約は docs/sandbox.md を正とする。
 *
 * 既定を `allow` にするのは後方互換のため。`ask` を既定にすると、承認の UI を持たない経路 (API 直叩き・
 * 旧クライアント) で `bash` の HTTPS が黙って止まる。
 */
import type { AskUserAnswer, NetworkAccessMode } from "./schema";

export type { NetworkAccessMode } from "./schema";

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
  /**
   * 拒否した接続先 (会話 id -> ホスト -> 拒否した時点の入力世代)。承認の記録と違い、ホストごとに持つ。
   * 同じ世代のままなら同じホストへの再要求を抑止し、ユーザー入力が増えたら抑止しない
   */
  private readonly denials = new Map<string, Map<string, number>>();

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

  /**
   * 拒否を記録する。ホストはカードに出た値 (正規化済み) を渡す。大文字小文字だけ違う別表記を
   * 別の拒否にしないよう、キーでは小文字化する
   */
  recordDenial(sessionId: string, host: string, generation: number): void {
    const hosts = this.denials.get(sessionId) ?? new Map<string, number>();
    hosts.set(host.toLowerCase(), generation);
    this.denials.set(sessionId, hosts);
  }

  /**
   * 同じホストへの再要求を抑止すべきか。別ホストは別の確認なので通し、ユーザー入力が増えた
   * (= 世代が進んだ) 場合も通す
   */
  isDenied(sessionId: string, host: string, generation: number): boolean {
    return this.denials.get(sessionId)?.get(host.toLowerCase()) === generation;
  }

  /**
   * 拒否の記録を捨てる。承認 (443 全体が開く)・会話削除・sweep で使う。停止では消さない
   * (停止後の run は新しい入力から始まるため、消しても結果が変わらない)
   */
  clearDenials(sessionId: string): void {
    this.denials.delete(sessionId);
  }

  /**
   * 1 つのホストの拒否だけを捨てる。拒否済みカードからの許可は、押したカードのホストだけを解く
   * (承認そのものは会話単位のまま)
   */
  clearDenial(sessionId: string, host: string): void {
    const hosts = this.denials.get(sessionId);
    if (hosts === undefined) return;
    hosts.delete(host.toLowerCase());
    if (hosts.size === 0) this.denials.delete(sessionId);
  }
}

/** 承認の回答から可否を取り出す。`approval` を持たない回答は未承認として扱う */
export function approvalOf(answer: AskUserAnswer | undefined): boolean {
  return answer?.approval === true;
}
