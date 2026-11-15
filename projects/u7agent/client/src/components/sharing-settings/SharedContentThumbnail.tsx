import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { cn } from "../../lib/cn";
import { sharedContentThumbnailUrl } from "../../lib/sharedThumbnail";
import type { SharedContentResponse } from "../../types";
import { ImageIcon, UploadIcon } from "../icons";

export type SharedContentThumbnailProps = {
  item: SharedContentResponse;
  /** 600px 未満。行の幅に合わせて枠を小さくする */
  narrow: boolean;
  /** 一括停止の実行中は一覧全体の操作を止める */
  disabled?: boolean;
  onOpen: () => void;
  /** 枠そのものへ運ばれた画像。設定済みでも差し替えの入口にする（押したときと同じダイアログが開く） */
  onDropFiles: (files: File[]) => void;
};

/**
 * 管理一覧の行のサムネイル。**枠そのものがボタン**で、未設定でも選ぶ入口になる。
 * ⋯ は公開中（`publishing`）に出さない規則なので、入口を ⋯ に置くと
 * 「公開状態と独立して設定できる」が崩れる。ドロップも同じ枠で受け、押したときと同じ面へ渡す。
 */
export function SharedContentThumbnail({
  item,
  narrow,
  disabled = false,
  onOpen,
  onDropFiles,
}: SharedContentThumbnailProps) {
  const thumbnail = item.thumbnail;
  const label = thumbnail === null ? `${item.name} のサムネイルを設定` : `${item.name} のサムネイルを変更`;
  const { active, handlers } = useFileDropTarget({ onFiles: onDropFiles, disabled });

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-label={label}
      title={thumbnail === null ? "画像を設定" : "画像を変更"}
      {...handlers}
      className={cn(
        "relative grid aspect-[16/10] shrink-0 place-items-center overflow-hidden rounded-lg border transition-colors",
        narrow ? "w-20" : "w-24",
        thumbnail === null ? "border-dashed" : "bg-raised",
        // 太さは outline で足す。枠の border を太くすると中の文字と画像が 1px ずれる
        active
          ? "border-accent/50 text-accent-text outline-2 outline-offset-2 outline-accent outline-dashed"
          : thumbnail === null
            ? "border-line-strong text-ink-faint hover:border-accent/50 hover:text-accent-text"
            : "border-line hover:border-accent/50",
        "disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      {thumbnail === null ? null : (
        <img
          src={sharedContentThumbnailUrl(item.id, thumbnail.updatedAt)}
          alt=""
          width={thumbnail.width}
          height={thumbnail.height}
          loading="lazy"
          decoding="async"
          className={cn("size-full object-cover", active && "opacity-25")}
        />
      )}
      {active ? (
        <span className="absolute inset-0 grid place-items-center bg-base/70 text-accent-text">
          <span className="flex flex-col items-center gap-0.5 text-2xs">
            <UploadIcon />
            ここにドロップ
          </span>
        </span>
      ) : thumbnail === null ? (
        <span className="flex flex-col items-center gap-0.5 text-2xs">
          <ImageIcon />
          画像を設定
        </span>
      ) : null}
    </button>
  );
}
