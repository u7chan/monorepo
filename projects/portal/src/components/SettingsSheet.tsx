// SettingsSheet - 外観の切り替えと、この portal 自身の接続先
//
// 以前はヘッダーに host と https の入口を並べていたが、狭い画面では省略記号で欠けて
// 読めなかった。使う頻度の低い情報なので、ここに移して全文を読める大きさで出す。

import { useId } from "react";
import type { ThemePreference } from "../lib/theme";
import { ArrowUpRightIcon, CloseIcon } from "./icons";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";
import { Sheet } from "./Sheet";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  host: string;
  httpsUrl: string;
  isMockMode: boolean;
  preference: ThemePreference;
  onPreferenceChange: (preference: ThemePreference) => void;
}

const APPEARANCE_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="mb-2 px-1 text-footnote font-medium tracking-wide text-label-2 uppercase">
      {children}
    </h3>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2.5">
      <dt className="shrink-0 text-callout text-label">{label}</dt>
      <dd className="min-w-0 text-right text-callout [overflow-wrap:anywhere] text-label-2">
        {children}
      </dd>
    </div>
  );
}

export function SettingsSheet({
  open,
  onClose,
  host,
  httpsUrl,
  isMockMode,
  preference,
  onPreferenceChange,
}: SettingsSheetProps) {
  const titleId = useId();
  const httpsHost = new URL(httpsUrl).host;

  return (
    <Sheet open={open} onClose={onClose} labelledBy={titleId}>
      <div className="overflow-hidden rounded-card bg-sheet shadow-sheet">
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          <h2 id={titleId} className="text-title-3 font-semibold text-label">
            Settings
          </h2>
          <button
            type="button"
            data-autofocus
            aria-label="Close"
            onClick={onClose}
            className="hit-area grid size-8 place-items-center rounded-full bg-fill text-label-2 transition-colors duration-150 can-hover:hover:bg-fill-strong active:bg-fill-strong"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div className="space-y-6 px-5 pt-4 pb-6">
          <section>
            <SectionTitle>Appearance</SectionTitle>
            <SegmentedControl
              label="Appearance"
              options={APPEARANCE_OPTIONS}
              value={preference}
              onChange={onPreferenceChange}
              className="w-full"
              segmentClassName="min-h-9 px-3"
            />
            <p className="mt-2 px-1 text-footnote text-label-2">
              Auto follows this device&rsquo;s setting.
            </p>
          </section>

          <section>
            <SectionTitle>This portal</SectionTitle>
            <dl className="divide-y divide-separator overflow-hidden rounded-tile bg-surface-2">
              <InfoRow label="Host">
                <span className="font-mono">{host}</span>
              </InfoRow>
              <InfoRow label="HTTPS">
                <a
                  href={httpsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${httpsUrl}`}
                  className="inline-flex items-center gap-1 font-mono text-accent"
                >
                  {httpsHost}
                  <ArrowUpRightIcon className="size-4 shrink-0" />
                </a>
              </InfoRow>
              {isMockMode && <InfoRow label="Data">Mock data</InfoRow>}
            </dl>
          </section>
        </div>
      </div>
    </Sheet>
  );
}

export default SettingsSheet;
