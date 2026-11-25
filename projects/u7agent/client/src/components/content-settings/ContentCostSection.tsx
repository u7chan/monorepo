import type { ContentSettingsResponse, UpdateContentCostBody } from "../../types";
import { CheckIcon } from "../icons";
import { ToggleSwitch } from "../ToggleSwitch";

/**
 * コストマスタの接続先。価格は手動の [カタログ更新] のときだけ取りに行く。未設定でも従来どおり動くため、
 * OFF の間は URL を残したまま入力欄だけを非活性にする。
 */
export function ContentCostSection({
  settings,
  busy,
  draft,
  onChangeDraft,
  onSave,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  draft: { enabled: boolean; url: string } | null;
  onChangeDraft: (draft: { enabled: boolean; url: string } | null) => void;
  onSave: (input: UpdateContentCostBody) => Promise<boolean>;
}) {
  const current = draft ?? { enabled: settings.cost.enabled, url: settings.cost.url ?? "" };
  const dirty = draft !== null;

  const submit = async () => {
    if (await onSave(current)) onChangeDraft(null);
  };

  return (
    <section className="grid gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">コスト表示</div>
          <p className="mt-0.5 text-xs text-ink">モデルの価格と「一覧に出すか」を任意のコストマスタから写します。</p>
        </div>
        <ToggleSwitch
          checked={current.enabled}
          label={current.enabled ? "ON" : "OFF"}
          disabled={busy}
          onChange={(enabled) => onChangeDraft({ ...current, enabled })}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-xs"
          type="url"
          inputMode="url"
          value={current.url}
          placeholder="https://cost-master.example.com/api/models"
          aria-label="コストマスタのURL"
          autoComplete="off"
          spellCheck={false}
          disabled={busy || !current.enabled}
          onChange={(event) => onChangeDraft({ ...current, url: event.currentTarget.value })}
        />
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void submit()}>
          <CheckIcon />
          保存
        </button>
      </div>
      <p className="text-2xs leading-relaxed break-words text-ink-muted">
        {current.enabled
          ? "手動の [カタログ更新] のときだけ取得します（起動時・定期・再読み込みでは取りに行きません）。"
          : "OFF の間は取得も価格表示もしません。URL は保存したまま残ります。"}{" "}
        未設定なら価格は表示されず、モデルの選択・保存・試行は今までどおり動きます。
      </p>
    </section>
  );
}
