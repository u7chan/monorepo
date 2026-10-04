/**
 * 入力欄への画像ペースト。クリップボードの画像は名前がブラウザー次第（`image.png` / `blob`）で
 * 拡張子も保証されないため、保存名を MIME から組み直してから添付経路へ渡す。純関数だけを置く。
 */

/** paste の `clipboardData` から読む分だけ（`DataTransferItemList` をそのまま渡せる） */
export type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

export type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike> | null;
};

/** subtype をそのまま拡張子にすると崩れる MIME だけを載せる（`image/png` などは subtype で足りる） */
const EXTENSION_OVERRIDES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/**
 * 添付名に使う拡張子。画像でない / 拡張子にできない MIME は undefined を返し、呼び出し側で
 * 既定の貼り付け動作へ倒す（`+xml` のような複合 subtype を切ると別形式の名前になるため）。
 */
export function imageExtensionForMime(type: string): string | undefined {
  const normalized = type.trim().toLowerCase();
  if (!normalized.startsWith("image/")) return undefined;
  const overridden = EXTENSION_OVERRIDES[normalized];
  if (overridden) return overridden;
  const subtype = normalized.slice("image/".length);
  return /^[a-z0-9]{1,10}$/.test(subtype) ? subtype : undefined;
}

/** 貼り付け画像の保存名。同じ秒の複数枚はサンドボックスの連番（`-1`）が分ける */
export function pastedImageName(extension: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("");
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  return `pasted-${date}-${time}.${extension}`;
}

/** paste の `clipboardData` から画像だけを取り出し、保存名を揃えた `File` にして返す */
export function pastedImageFiles(data: ClipboardDataLike | null | undefined, now: Date): File[] {
  const items = data?.items;
  if (!items || items.length === 0) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const type = item.type.trim();
    const extension = imageExtensionForMime(type);
    if (extension === undefined) continue;
    const file = item.getAsFile();
    if (file === null) continue;
    files.push(new File([file], pastedImageName(extension, now), { type: file.type || type }));
  }
  return files;
}
