import { useEffect, useState } from "react";
import { latestTrial, trialPanelState, type TrialPanelState } from "../lib/contentTrials";
import type { ContentSettingsResponse, ContentTrial, ContentTrialSummary } from "../types";
import { createRequestGate } from "./requestGate";

/** 面が扱う試行の種別。一覧は全種別を 1 回で取るため、面ごとに自分の種別だけを抜き出す */
type TrialKind = ContentTrialSummary["kind"];

/** ひとつの面 (画像 / 音声 / BGM) が出す値。表示の分岐はセクションが持つ */
export type TrialSectionState = {
  /** 面の状態。runtime 不可 / 未設定 / 全体 OFF / 空 / 実行中 / 失敗 / 中断 / 準備完了 */
  panel: TrialPanelState;
  /** 実行中の行 (1 面につき 1 本) */
  running: ContentTrialSummary | null;
  /** 直近の行 (要約)。無ければ null */
  latest: ContentTrialSummary | null;
  /** 直近の行の全文。取れるまでは null で、面は抜粋を出す */
  latestDetail: ContentTrial | null;
};

/**
 * 生成トライアルの 1 面ぶんの導出と、直近の行の全文の取得。種別は引数で受け、一覧 (全種別) から
 * その種別だけを抜き出して `panel` / `running` / `latest` を決める。全文は要約に載らないため行が
 * 変わるたびに取り直し、取れるまでは null を返す (面は抜粋を描く)。
 * `onLoadTrial` は依存に入るので、呼び出し側で identity を固定する (変わるたびに取り直す)。
 */
export function useTrialSection({
  kind,
  settings,
  trials,
  onLoadTrial,
}: {
  /** この面が扱う種別。一覧の種別で絞る (別種別の履歴を混ぜない) */
  kind: TrialKind;
  /** パネルの状態を決める可否 (runtime / 設定済み / 全体 ON) を読む */
  settings: ContentSettingsResponse;
  /** 全種別の一覧 (要約)。未取得は null */
  trials: readonly ContentTrialSummary[] | null;
  /** 直近の行の全文を取る */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
}): TrialSectionState {
  const list = (trials ?? []).filter((trial) => trial.kind === kind);
  const panel = trialPanelState({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    trials: list,
  });
  const running = list.find((trial) => trial.state === "running") ?? null;
  const latest = latestTrial(list);
  const latestId = latest?.id ?? null;

  // 一覧は抜粋しか持たないため、直近の行の全文を取る。行が変わったら前の全文を残さない
  const [latestDetail, setLatestDetail] = useState<ContentTrial | null>(null);
  const [beginLoad] = useState(createRequestGate);
  useEffect(() => {
    if (latestId === null) {
      setLatestDetail(null);
      return;
    }
    // 行が変わった直後に前の行の全文を新しい行のものとして出さない（取れるまでは抜粋）
    setLatestDetail(null);
    const canApply = beginLoad();
    void onLoadTrial(latestId).then((trial) => {
      if (canApply()) setLatestDetail(trial);
    });
    // 破棄された取得 (行の切り替え / unmount) の応答を、切り替え後の行へ適用しない
    return () => {
      beginLoad();
    };
  }, [beginLoad, latestId, onLoadTrial]);

  return { panel, running, latest, latestDetail };
}
