import type { ContentSettingsResponse, ContentTrialSummary } from "../../types";
import { EvidenceLine } from "./ImageTrialSection";

/**
 * 音楽（BGM）の保存される設定。モデルは固定で選ばせないため、読取専用の 1 行と証拠だけを出し、
 * 入力と結果は試行の面（`BgmTrialSection`）へ置く。
 */
export function BgmModelSection({
  settings,
  trials,
  keyEpoch,
  now,
}: {
  settings: ContentSettingsResponse;
  trials: readonly ContentTrialSummary[] | null;
  keyEpoch: number;
  now: number;
}) {
  return (
    <section className="grid min-w-0 gap-1.5 border-t border-line pt-3">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">保存される設定</h3>
      <label className="grid min-w-0 gap-1.5 text-2xs text-ink-muted">
        固定モデル（変更不可）
        <input
          className="field min-w-0 text-xs"
          aria-label="BGM生成の固定モデル"
          readOnly
          value={settings.bgm.model ?? ""}
        />
      </label>
      {/* キーの有効性は緑のバッジにせず、現在のキー世代の実績だけを証拠として出す */}
      <EvidenceLine trials={trials} model={settings.bgm.model ?? ""} keyEpoch={keyEpoch} now={now} />
      <p className="text-2xs leading-relaxed text-ink-muted">
        モデル仕様では{settings.bgm.expectedDurationSeconds}秒のクリップを{settings.bgm.format.toUpperCase()}
        で生成します（実測の尺ではありません）。生成は課金対象で、プロンプトをOpenRouterと生成プロバイダーへ外部送信します。
      </p>
      <p className="text-2xs leading-relaxed text-ink-muted">
        ボーカルなし・正確なBPMや尺・シームレスループは保証しません。失敗や中断でも課金される可能性があるため、自動で再生成しません。
      </p>
    </section>
  );
}
