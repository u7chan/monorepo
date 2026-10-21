import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  ENV_VALUE_ERROR_NOTE,
  ENV_VALUE_PENDING,
  envValueOverflows,
  envValueSegments,
  envValueToggleLabel,
} from "../lib/envValue";
import { CheckIcon, CopyIcon } from "./icons";

export type EnvValueBoxProps = {
  /** 取得済みの値。未取得は undefined で、取得中は `…` を出す (空文字の値は保存できない) */
  value: string | undefined;
  /** 取得の失敗。404 は一覧の取り直しへ回すため、ここへは渡さない */
  failure: string | undefined;
  /** 全文を開いているか。開閉は行ごとに閉じる */
  expanded: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: (value: string) => void;
};

/**
 * 変数行の値。1 行に収まるときは 1 行、あふれるときだけ 2 行で省略して開閉を出す。
 * 計測は値の `<code>` で行う (箱はコピーのボタンを含むため clientHeight が行高と一致しない)。
 */
export function EnvValueBox({ value, failure, expanded, copied, onToggle, onCopy }: EnvValueBoxProps) {
  const codeRef = useRef<HTMLElement | null>(null);
  const codeId = useId();
  // 省略の有無。開いている間は clamp が外れて測れないため、閉じているときの判定をそのまま使う
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = codeRef.current;
    if (el === null) return;
    const measure = () => {
      // 開いている間は測らない (scrollHeight が clientHeight に揃い、たたむ導線が消える)
      if (expanded) return;
      setClamped(envValueOverflows({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    };
    measure();
    // パネルの幅のドラッグ中は React を再描画しないため、要素のサイズの変化から測り直す
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    observer.observe(el);
    return () => observer.disconnect();
    // failure で箱ごと注記へ差し替わるため、値が同じでも要素が戻ったら測り直す
  }, [expanded, failure, value]);

  if (failure !== undefined) {
    return (
      <p className="text-2xs text-danger-text" title={failure}>
        {ENV_VALUE_ERROR_NOTE}
      </p>
    );
  }

  return (
    <div className="grid justify-items-start gap-0.5">
      {/* 行のカードの中に枠を重ねない (箱は行の中の 1 行として出す) */}
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <code
          ref={codeRef}
          id={codeId}
          className={cn(
            "min-w-0 flex-1 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-ink-muted",
            // clamp は上限なので、短い値の行高は増えない (2 行へ固定しない)
            expanded ? "" : "line-clamp-2",
          )}
        >
          {value === undefined ? (
            <span className="text-ink-faint">{ENV_VALUE_PENDING}</span>
          ) : (
            envValueSegments(value).map((segment, index, segments) => (
              <Fragment key={index}>
                {segment}
                {/* 区切りの直後で折り返せるようにする。コピーは原文をそのまま渡す */}
                {index < segments.length - 1 ? <wbr /> : null}
              </Fragment>
            ))
          )}
        </code>
        {value === undefined ? null : (
          <button
            type="button"
            onClick={() => onCopy(value)}
            aria-label={copied ? "コピーしました" : "値をコピー"}
            title={copied ? "コピーしました" : "値をコピー"}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-md transition-colors",
              copied ? "text-ok" : "text-ink-faint hover:bg-raised hover:text-accent-text",
            )}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
      </div>
      {clamped ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={codeId}
          onClick={onToggle}
          className="inline-flex min-h-6 items-center rounded-md px-1.5 text-2xs font-medium text-ink-muted transition-colors outline-none hover:bg-raised hover:text-accent-text focus-visible:ring-1 focus-visible:ring-focus"
        >
          {envValueToggleLabel(expanded)}
        </button>
      ) : null}
    </div>
  );
}
