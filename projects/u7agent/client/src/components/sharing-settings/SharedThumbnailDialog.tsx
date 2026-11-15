import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../ConfirmProvider";
import { sharedContentThumbnailClearConfirm } from "../../lib/sharedContents";
import {
  INITIAL_THUMBNAIL_CROP,
  clampThumbnailCrop,
  panThumbnailCrop,
  sharedContentThumbnailUrl,
  THUMBNAIL_DROP_EXTRA_NOTE,
  thumbnailKeyStep,
  thumbnailMaxZoom,
  THUMBNAIL_ASPECT,
  type ThumbnailCrop,
} from "../../lib/sharedThumbnail";
import {
  drawThumbnailPreview,
  loadThumbnailSource,
  renderThumbnailPng,
  type ThumbnailSource,
} from "../../lib/sharedThumbnailFile";
import type { SharedContentResponse } from "../../types";
import { ImageIcon } from "../icons";
import { LoadingMark } from "../LoadingMark";

/**
 * プレビューの描画解像度。CSS で `w-full` にして、切り抜きの計算とドラッグの換算にはこの値を使う。
 * 保存する PNG の寸法は元画像と倍率から決まる（`thumbnailCropRect`）ので、この値には依存しない。
 */
const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = Math.round(PREVIEW_WIDTH / THUMBNAIL_ASPECT);

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SharedThumbnailDialogProps = {
  item: SharedContentResponse;
  /** 枠へドロップして開いたときの画像と、使わなかった枚数。開いた直後に `画像を選ぶ` と同じ経路で読み込む */
  dropped: { file: File; ignored: number } | null;
  onClose: () => void;
  /** 保存。失敗した理由は BFF の固定文言をそのまま返し、ダイアログ内に出す */
  onSave: (bytes: Uint8Array) => Promise<{ ok: boolean; message?: string }>;
  onClear: () => Promise<{ ok: boolean; message?: string }>;
};

/**
 * 共有物のサムネイルを選び、16:10 で切り抜いて保存するダイアログ。
 * 位置はドラッグ / タッチ / 矢印キー、倍率はスライダーか +/- で調整でき、保存と解除も同じ面で行う。
 * 未保存で閉じれば既存の画像は変わらない（保存は押したときだけ送る）。枠へのドロップもこの面へ合流させる。
 */
export function SharedThumbnailDialog({ item, dropped, onClose, onSave, onClear }: SharedThumbnailDialogProps) {
  const confirm = useConfirm();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<ThumbnailSource | null>(null);
  const [crop, setCrop] = useState<ThumbnailCrop>(INITIAL_THUMBNAIL_CROP);
  const [busy, setBusy] = useState<"reading" | "saving" | "clearing" | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // 落とした画像を 1 枚だけ使った理由。選び直したら消す
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const dragRef = useRef<{ x: number; y: number; crop: ThumbnailCrop } | null>(null);

  // 開いたらモーダルにし、閉じたら焦点を元の行へ戻す（QR と同じ作法）
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // デコードしたビットマップは明示的に解放する（2 MiB 上限でも元画像は大きいことがある）
  useEffect(() => {
    return () => {
      source?.bitmap.close();
    };
  }, [source]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    drawThumbnailPreview(canvas, source, crop);
  }, [source, crop]);

  const pick = async (file: File, note?: string) => {
    setError(undefined);
    setNotice(undefined);
    setBusy("reading");
    try {
      const next = await loadThumbnailSource(file);
      setSource(next);
      setCrop(INITIAL_THUMBNAIL_CROP);
      // 読めて初めて「1 枚だけ使った」と言える。読めなかったときはエラーだけを残す
      setNotice(note);
    } catch (pickError) {
      setError(messageFor(pickError));
    } finally {
      setBusy(null);
    }
  };

  // 開いたときの 1 回だけ読む。閉じたあとの差し替えは「画像を選ぶ」から行う
  useEffect(() => {
    if (dropped === null) return;
    void pick(dropped.file, dropped.ignored > 0 ? THUMBNAIL_DROP_EXTRA_NOTE : undefined);
    // dropped は開いた時点の値で、以後は変わらない
  }, []);

  const save = async () => {
    if (!source || busy !== null) return;
    setError(undefined);
    setBusy("saving");
    try {
      const bytes = await renderThumbnailPng(source, crop);
      const result = await onSave(bytes);
      if (result.ok) onClose();
      else setError(result.message ?? "サムネイルを保存できませんでした");
    } catch (saveError) {
      setError(messageFor(saveError));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (busy !== null) return;
    if (!(await confirm(sharedContentThumbnailClearConfirm(item)))) return;
    setError(undefined);
    setBusy("clearing");
    try {
      const result = await onClear();
      if (result.ok) onClose();
      else setError(result.message ?? "サムネイルを外せませんでした");
    } finally {
      setBusy(null);
    }
  };

  const maxZoom = source === null ? 1 : thumbnailMaxZoom(source.width, source.height);
  const current = item.thumbnail;

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={`${item.name} のサムネイル`}
      tabIndex={-1}
      // Escape と close を背面の設定画面へ伝播させない（1 回でこのダイアログだけを閉じる）
      onCancel={(event) => {
        event.stopPropagation();
      }}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel"
    >
      <div className="flex max-h-[min(88dvh,760px)] flex-col">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-strong">サムネイル</h2>
          <p className="line-clamp-1 min-w-0 text-2xs break-words text-ink-muted" title={item.name}>
            {item.name}
          </p>
        </header>

        <div className="grid min-h-0 content-start gap-3 overflow-y-auto px-4 py-3.5">
          <p className="text-2xs leading-relaxed text-ink-faint">
            共有物の代表画像です。公開している内容と自動では一致しません。16:10 に切り抜いて保存します。
          </p>

          {source === null ? (
            current === null ? (
              <div className="grid place-items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-2xs text-ink-faint">
                <ImageIcon />
                画像が設定されていません。
              </div>
            ) : (
              <img
                src={sharedContentThumbnailUrl(item.id, current.updatedAt)}
                alt=""
                width={current.width}
                height={current.height}
                className="w-full rounded-lg border border-line bg-raised object-cover"
              />
            )
          ) : (
            <div
              role="group"
              aria-label="切り抜き範囲"
              tabIndex={0}
              onKeyDown={(event) => {
                if (source === null) return;
                const next = thumbnailKeyStep(crop, event.key, source.width, source.height);
                if (next === undefined) return;
                event.preventDefault();
                setCrop(next);
              }}
              className="touch-none rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
            >
              <canvas
                ref={canvasRef}
                width={PREVIEW_WIDTH}
                height={PREVIEW_HEIGHT}
                aria-hidden="true"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragRef.current = { x: event.clientX, y: event.clientY, crop };
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag) return;
                  setCrop(
                    panThumbnailCrop(
                      drag.crop,
                      { dx: event.clientX - drag.x, dy: event.clientY - drag.y },
                      PREVIEW_WIDTH,
                      PREVIEW_HEIGHT,
                      source.width,
                      source.height,
                    ),
                  );
                }}
                onPointerUp={() => {
                  dragRef.current = null;
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
                className="block w-full cursor-grab touch-none rounded-lg border border-line bg-raised active:cursor-grabbing"
              />
            </div>
          )}

          {source === null ? null : (
            <div className="grid gap-2">
              <label className="grid gap-1 text-2xs text-ink-muted">
                倍率
                <input
                  type="range"
                  min={1}
                  max={maxZoom}
                  step={0.01}
                  value={clampThumbnailCrop(crop, source.width, source.height).zoom}
                  onChange={(event) => {
                    const zoom = Number(event.currentTarget.value);
                    setCrop((prev) => clampThumbnailCrop({ ...prev, zoom }, source.width, source.height));
                  }}
                  className="w-full accent-accent"
                />
              </label>
              <p className="text-2xs leading-relaxed text-ink-faint">
                ドラッグ（タッチ）か矢印キーで位置、スライダーか +/- キーで倍率を変えられます。
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                // 同じファイルを選び直せるように、選択を毎回リセットする
                event.currentTarget.value = "";
                if (file) void pick(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
              className="btn-quiet singleColumn:min-h-11"
            >
              <ImageIcon />
              {source === null ? (current === null ? "画像を選ぶ" : "画像を変える") : "別の画像を選ぶ"}
            </button>
            {busy === "reading" ? (
              <span className="flex items-center gap-1.5 text-2xs text-ink-muted">
                <LoadingMark />
                読み込んでいます。
              </span>
            ) : null}
          </div>

          {error === undefined ? null : (
            <p role="alert" className="text-2xs break-words text-danger-text">
              {error}
            </p>
          )}
          {notice === undefined ? null : (
            <p className="text-2xs leading-relaxed break-words text-ink-muted">{notice}</p>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <div className="flex items-center gap-2">
            {current === null ? null : (
              <button
                type="button"
                onClick={() => {
                  void clear();
                }}
                disabled={busy !== null}
                className="btn-quiet text-danger-text singleColumn:min-h-11"
              >
                外す
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              ref={closeRef}
              type="button"
              onClick={() => dialogRef.current?.close()}
              disabled={busy === "saving" || busy === "clearing"}
              className="btn-quiet singleColumn:min-h-11"
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={() => {
                void save();
              }}
              disabled={source === null || busy !== null}
              className="btn-primary singleColumn:min-h-11"
            >
              {busy === "saving" ? "保存しています…" : "保存する"}
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
