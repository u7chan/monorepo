import { useCopy } from "../../hooks/useCopy";
import { describeImage } from "../../lib/image";
import { CopyButton, REVEAL_CARD } from "../CopyButton";

/**
 * イメージ名とコピーボタン。
 * 長い名前は 1 行に収め、レジストリや名前空間から先に省略する。折り返すとカードごとの
 * 高さが読めなくなり、末尾から切ると「どのタグか」が消える。全文は title とコピーで拾える。
 */
export function ImageField({ image }: { image: string }) {
  const { copied, copy } = useCopy();
  const { prefix, name, version } = describeImage(image);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <p className="flex min-w-0 font-mono text-footnote text-label-2" title={image}>
        <span className="min-w-0 truncate">{prefix}</span>
        <span className="max-w-full shrink-0 truncate">
          {name}
          {version}
        </span>
      </p>
      <CopyButton
        copied={copied}
        onClick={() => void copy(image)}
        label="Copy image name"
        revealClass={REVEAL_CARD}
      />
    </div>
  );
}
