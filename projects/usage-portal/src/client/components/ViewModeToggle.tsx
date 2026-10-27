import type { ViewMode } from "../lib/view-mode";

const OPTIONS: readonly { mode: ViewMode; label: string }[] = [
  { mode: "compact", label: "簡易" },
  { mode: "standard", label: "標準" },
];

/** カードの密度だけを切り替える。推移を見たいときは標準、件数を一望したいときは簡易。 */
export function ViewModeToggle(props: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div class="up-segmented" role="group" aria-label="表示の切り替え">
      {OPTIONS.map((option) => (
        <button
          key={option.mode}
          class="up-segment"
          type="button"
          aria-pressed={props.mode === option.mode}
          onClick={() => props.onChange(option.mode)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
