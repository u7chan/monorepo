import { cn } from "../../lib/cn";
import {
  CONTENT_IMAGE_PROVIDER_HEADING,
  IMAGE_PROVIDER_OPTIONS,
  SPEECH_NEEDS_OPENROUTER_KEY_NOTE,
  contentImageProviderLabel,
  imageAuthBadge,
  imageAuthNotice,
} from "../../lib/contentSettings/image";
import type { ContentSettingsResponse, ImageGenerationProvider } from "../../types";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";

/**
 * 画像の生成元。キー未設定でも選べるよう、設定パネルの外に出す（Codex はAPIキーを使わない）。
 * 認証の有無は保存値を読んだ結果（`settings.image.auth`）を出すだけで、この画面から解決しない。
 */
export function ImageProviderSection({
  settings,
  busy,
  onSave,
  onSaved,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  onSave: (provider: ImageGenerationProvider) => Promise<boolean>;
  onSaved: () => void;
}) {
  const current = settings.image.provider;
  const notice = imageAuthNotice(settings);
  return (
    <section className="grid gap-2 rounded-lg border border-line bg-raised px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
          {CONTENT_IMAGE_PROVIDER_HEADING}
        </h3>
        <ProviderBadgeTag badge={imageAuthBadge(settings.image.auth)} />
        <span className="text-2xs text-ink-ghost">{contentImageProviderLabel(current)}</span>
      </div>
      <div role="radiogroup" aria-label={CONTENT_IMAGE_PROVIDER_HEADING} className="grid gap-1.5">
        {IMAGE_PROVIDER_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2",
              option.value === current ? "border-accent/60 bg-soft" : "border-line bg-base",
              busy ? "opacity-60" : null,
            )}
          >
            <input
              type="radio"
              name="content-image-provider"
              className="mt-0.5"
              value={option.value}
              checked={option.value === current}
              disabled={busy}
              onChange={() => {
                if (option.value === current) return;
                void onSave(option.value).then((saved) => {
                  if (saved) onSaved();
                });
              }}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-xs font-semibold text-ink-strong">{option.label}</span>
              <span className="text-2xs leading-relaxed text-ink-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      {notice === null ? null : (
        <p
          role="status"
          className="rounded border border-warn/40 bg-base px-2 py-1.5 text-2xs leading-relaxed text-warn"
        >
          {notice}
        </p>
      )}
      {current === "codex" ? (
        <p className="text-2xs leading-relaxed text-ink-muted">{SPEECH_NEEDS_OPENROUTER_KEY_NOTE}</p>
      ) : null}
      <p className="text-2xs leading-relaxed text-ink-muted">
        生成元を切り替えても、他方のキーとモデルは残ります。切り替えは保存した瞬間から
        <strong>既存の会話</strong>
        の次の呼び出しにも効きます（未設定から有効にしたときだけ、ツールを持たない会話には新しい会話が必要です）。
      </p>
    </section>
  );
}
