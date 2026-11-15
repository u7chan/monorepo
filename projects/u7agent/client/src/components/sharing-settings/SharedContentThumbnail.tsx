import { cn } from "../../lib/cn";
import { sharedContentThumbnailUrl } from "../../lib/sharedThumbnail";
import type { SharedContentResponse } from "../../types";
import { ImageIcon } from "../icons";

export type SharedContentThumbnailProps = {
  item: SharedContentResponse;
  /** 600px 未満。行の幅に合わせて枠を小さくする */
  narrow: boolean;
  /** 一括停止の実行中は一覧全体の操作を止める */
  disabled?: boolean;
  onOpen: () => void;
};

/**
 * 管理一覧の行のサムネイル。**枠そのものがボタン**で、未設定でも選ぶ入口になる。
 * ⋯ は公開中（`publishing`）に出さない規則なので、入口を ⋯ に置くと
 * 「公開状態と独立して設定できる」が崩れる。
 */
export function SharedContentThumbnail({ item, narrow, disabled = false, onOpen }: SharedContentThumbnailProps) {
  const thumbnail = item.thumbnail;
  const label = thumbnail === null ? `${item.name} のサムネイルを設定` : `${item.name} のサムネイルを変更`;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-label={label}
      title={thumbnail === null ? "画像を設定" : "画像を変更"}
      className={cn(
        "grid aspect-[16/10] shrink-0 place-items-center overflow-hidden rounded-lg border transition-colors",
        narrow ? "w-20" : "w-24",
        thumbnail === null
          ? "border-dashed border-line-strong text-ink-faint hover:border-accent/50 hover:text-accent-text"
          : "border-line bg-raised hover:border-accent/50",
        "disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      {thumbnail === null ? (
        <span className="flex flex-col items-center gap-0.5 text-2xs">
          <ImageIcon />
          画像を設定
        </span>
      ) : (
        <img
          src={sharedContentThumbnailUrl(item.id, thumbnail.updatedAt)}
          alt=""
          width={thumbnail.width}
          height={thumbnail.height}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      )}
    </button>
  );
}
