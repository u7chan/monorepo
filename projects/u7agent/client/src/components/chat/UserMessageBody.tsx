import { useLayoutEffect, useId, useRef, useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { measureUserMessageClamp } from "../../lib/userMessage";
import { CollapseChevronIcon } from "../icons";

/**
 * user バブルの本文。長いときは CSS (.user-message-clamp) の高さで切って、開閉ボタンを出す。
 * 開いた高さは実測した scrollHeight を CSS 変数で渡す。interpolate-size のような新しい CSS に
 * 頼らず、`max-block-size` の遷移だけで開閉をアニメーションさせるため。
 */
export function UserMessageBody({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  // 確定済みの clamp の高さ (px)。縮小の遷移中は clientHeight が動くため、判定の基準をこちらへ固定する
  const clampHeightRef = useRef(0);
  // 切り取る高さを超えているか。開閉ボタンとフェードの出し分けに使う
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // 開いたときの高さ (px)。アニメーション後も本文がクリップされない値まで広げる
  const [openHeight, setOpenHeight] = useState(0);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      // 開いている間も scrollHeight は全文の高さを返す
      if (expanded) setOpenHeight(el.scrollHeight);
      const next = measureUserMessageClamp({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        clampHeight: clampHeightRef.current,
      });
      clampHeightRef.current = next.clampHeight;
      setClamped(next.clamped);
    };
    measure();
    // display: none で mount された (設定ページを開いた状態で起動) ときは、
    // サイズが付いた時点で測り直す
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  function toggle(): void {
    if (!expanded) {
      const el = bodyRef.current;
      if (el) setOpenHeight(el.scrollHeight);
    }
    setExpanded((value) => !value);
  }

  return (
    <>
      <div className="relative">
        <div
          ref={bodyRef}
          id={bodyId}
          className={cn(
            "user-message-clamp break-words whitespace-pre-wrap",
            expanded ? "user-message-clamp-open" : "",
          )}
          style={expanded ? ({ "--user-message-height": `${openHeight}px` } as CSSProperties) : undefined}
        >
          {text}
        </div>
        {clamped ? (
          <div aria-hidden="true" className={cn("user-message-fade", expanded ? "opacity-0" : "opacity-100")} />
        ) : null}
      </div>
      {clamped ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggle}
          className="mt-1 inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 font-sans text-2xs font-medium text-on-accent/75 transition-colors outline-none hover:bg-on-accent/10 hover:text-on-accent focus-visible:ring-1 focus-visible:ring-on-accent"
        >
          <CollapseChevronIcon />
          {expanded ? "折りたたむ" : "続きを表示"}
        </button>
      ) : null}
    </>
  );
}
