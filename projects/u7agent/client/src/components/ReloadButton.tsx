import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { ReloadGlyph } from "./icons";

/** ボタンの寸法。余白と文字サイズはこの表が持ち、呼び出し側は layout だけを渡す */
export type ReloadButtonSize = "md" | "sm";

/** sm は設定のサイドバー (節見出し) に並べる小さい寸法 */
const SIZE_CLASS: Record<ReloadButtonSize, string> = {
  md: "",
  sm: cn("shrink-0 gap-1 px-1.5 py-0.5"),
};

export type ReloadButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "className" | "onClick" | "children"
> & {
  onClick: () => void;
  /** ラベル。狭い面で見出しと重複するときは aria-label を別に渡す */
  children: ReactNode;
  size?: ReloadButtonSize;
  /** layout (位置・幅・伸縮) だけを渡す */
  className?: string;
};

/**
 * 取り直しのボタン (再読み込み / 再取得 / 再同期 / 再実行)。同じ印を使う操作を 1 つにまとめる。
 * 押した瞬間だけアイコンを 1 回転させ、操作が始まったことを示す。回転は取得の完了に紐づけない:
 * 完了を待つと、速い応答では見えず、応答が返らないときは回りっぱなしになって「止まった」と区別できない。
 * 演出の寸法と、動きを止める設定での扱いは docs/frontend.md が正。
 */
export function ReloadButton({ onClick, children, size = "md", className, ...props }: ReloadButtonProps) {
  // 押した回数。0 (初回の描画) では class を付けないので回らない
  const [pressed, setPressed] = useState(0);
  return (
    <button
      {...props}
      type="button"
      onClick={() => {
        setPressed((count) => count + 1);
        onClick();
      }}
      className={cn("btn-quiet", SIZE_CLASS[size], className)}
    >
      <svg
        // key を変えて要素を作り直し、連打でも 1 回転目から回し直す
        key={pressed}
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("size-3.5 shrink-0", pressed > 0 && "reload-spin")}
      >
        <ReloadGlyph />
      </svg>
      {children}
    </button>
  );
}
