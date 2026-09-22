import { useState } from "react";
import { isAgentIcon } from "../lib/agentIcon";
import { cn } from "../lib/cn";
import { SparkleIcon } from "./icons";

/** 表示する場所ごとの寸法と枠。呼び出し側は位置だけを渡す */
export type AgentIconVariant = "list" | "inline" | "bubble" | "hero" | "preview";

/** 単独で置く箱 (吹き出し / firstview / エディタのプレビュー) の枠と塗り */
const BOX_CHROME = cn("border border-accent/25 bg-accent-wash text-accent-strong");

/**
 * 一覧と行の中の印 (コンポーザー / セッション行) は枠と塗りを持たず、文字色を行から継ぐ。
 * 単独で置く箱は、未設定のときも箱として見えるよう枠と塗りを持つ。
 */
const VARIANT_CLASS: Record<AgentIconVariant, string> = {
  list: cn("size-4 rounded-sm"),
  inline: cn("size-3.5 rounded-sm"),
  bubble: cn("rounded-lg", BOX_CHROME),
  hero: cn("rounded-xl", BOX_CHROME),
  preview: cn("rounded-xl", BOX_CHROME),
};

/** 単独で置く箱の寸法 (list / inline は VARIANT_CLASS が持つ) */
const BOX_CLASS: Partial<Record<AgentIconVariant, string>> = {
  bubble: cn("size-6.5"),
  hero: cn("size-10.5"),
  preview: cn("size-12"),
};

/** 画像は装飾なので alt は空にし、読み上げ名は隣のテキスト (エージェント名など) が持つ */
export function AgentIcon({
  icon,
  variant,
  compact = false,
}: {
  /** 未設定・形式違いは SparkleIcon にフォールバックする */
  icon?: string;
  variant: AgentIconVariant;
  /** bubble だけ。狭い layout では 1 段小さくする */
  compact?: boolean;
}) {
  // 読み込みに失敗した src を覚えて、同じ画像を再試行させず SparkleIcon へ切り替える
  const [failedIcon, setFailedIcon] = useState<string>();
  const source = isAgentIcon(icon) ? icon : undefined;
  const showImage = source !== undefined && source !== failedIcon;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden",
        VARIANT_CLASS[variant],
        variant === "bubble" && compact ? "size-5.5" : BOX_CLASS[variant],
      )}
    >
      {showImage ? (
        <img
          src={source}
          alt=""
          className="size-full object-contain"
          onError={() => {
            setFailedIcon(source);
          }}
        />
      ) : (
        <SparkleIcon />
      )}
    </span>
  );
}
