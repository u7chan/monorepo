import { cn } from "../lib/cn";

/**
 * 通知のトグルが働かない理由と、設定を開く導線。バーの下に 1 行で出す (色ではなく文字で示す)。
 * 導線は行の中に置く: 別の行にすると compact のバーが 1 段高くなり、実測の前提 (docs/ui-layout.md) が変わる。
 */
export function NotifyNote({
  text,
  onOpenSettings,
  className,
}: {
  text: string;
  onOpenSettings?: () => void;
  className?: string;
}) {
  return (
    <p role="status" className={cn("text-1xs leading-relaxed text-ink-soft", className)}>
      {text}
      {onOpenSettings ? (
        <>
          {" "}
          <button
            type="button"
            // 周囲と同じ字と行間にする (UA の button スタイルに戻さない)
            className="text-1xs leading-relaxed text-accent-text underline underline-offset-2"
            onClick={onOpenSettings}
          >
            設定を開く
          </button>
        </>
      ) : null}
    </p>
  );
}
