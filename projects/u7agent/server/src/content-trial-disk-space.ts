/**
 * 試行を始める前のディスクの空き確認。成果物の置き場 (`<storeDir>/trials`) の空きが 1 件分に満たないとき、
 * 生成（課金）の前に開始を拒否する（契約と理由は docs/api-settings.md）。
 */
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { TRIAL_ARTIFACT_MAX_BYTES } from "./content-trial-artifacts";

/**
 * 1 件分の見込みに足す余白。保存は最終パスへ直接書く（一時ファイルを作らない）ため、保存中の伸びではなく、
 * 生成の間に同じ領域のアプリ DB / 会話ストアが書く分と、他の種別の試行が同時に保存する分に備える。
 */
export const TRIAL_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** 試行 1 本を始めるのに要る空き。保存の 1 件の上限に余白を足す */
export const TRIAL_DISK_REQUIRED_BYTES = TRIAL_ARTIFACT_MAX_BYTES + TRIAL_DISK_MARGIN_BYTES;

/** 空きの読み口。既定は `fs/promises` の `statfs` で、テストは固定値を返すものへ差し替える */
export type TrialStatfs = (path: string) => Promise<{ bsize: number; bavail: number }>;

/** 判定結果。`enough` は「空きを測れなかった」も含む（測れない環境で正しい試行を止めない） */
export type TrialDiskVerdict = "enough" | "short";

export type TrialDiskCheck = () => Promise<TrialDiskVerdict>;

/** 空きの読み取り。非対応の fs や権限の失敗は「測れない」として `undefined` を返す */
async function freeBytesOf(read: TrialStatfs, path: string): Promise<number | undefined> {
  try {
    const stats = await read(path);
    // 一般ユーザーが実際に書けるのは bavail（root 予約を除いた残り）で、bfree ではない
    return stats.bsize * stats.bavail;
  } catch {
    return undefined;
  }
}

export function createTrialDiskCheck(deps: { dir: string; statfs?: TrialStatfs | undefined }): TrialDiskCheck {
  const read = deps.statfs ?? statfs;
  return async () => {
    // 置き場は初回の保存まで無いため、読めないときは作られる親の空きで判定する。
    // どちらも読めない環境では通す側に倒す（空きを測れないだけで正しい試行まで止めない）
    const freeBytes = (await freeBytesOf(read, deps.dir)) ?? (await freeBytesOf(read, dirname(deps.dir)));
    if (freeBytes === undefined) return "enough";
    return freeBytes < TRIAL_DISK_REQUIRED_BYTES ? "short" : "enough";
  };
}
