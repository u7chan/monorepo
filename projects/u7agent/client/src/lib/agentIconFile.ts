import { AGENT_ICON_BOX, fitIconSize, isAgentIcon } from "./agentIcon";

/** webp の品質候補 (高い順)。16 KiB を超えるたびに落とし、それでも駄目なら箱を縮めて再試行する */
const WEBP_QUALITIES = [0.9, 0.75, 0.6, 0.45];
/** 箱を縮めて再試行する下限 (表示は最大 42px なので、これ以上は縮めない) */
const MIN_BOX = 64;

/** toBlob の結果を data URL へ読む。FileReader は onload の result が string | ArrayBuffer なので String で寄せる */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("画像を読み込めませんでした"));
    reader.readAsDataURL(blob);
  });
}

async function canvasToDataUrl(canvas: HTMLCanvasElement, type: string, quality: number): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("画像を変換できませんでした");
  return blobToDataUrl(blob);
}

/** webp でエンコードする。返せない環境 (古い Safari など) は canvas が png へ落とすので、その結果を返す */
async function encodeIcon(canvas: HTMLCanvasElement): Promise<string> {
  let dataUrl = "";
  for (const quality of WEBP_QUALITIES) {
    dataUrl = await canvasToDataUrl(canvas, "image/webp", quality);
    // png へフォールバックした環境では品質を変えても同じ結果になるため、1 回で抜ける
    if (!dataUrl.startsWith("data:image/webp;") || isAgentIcon(dataUrl)) return dataUrl;
  }
  return dataUrl;
}

function drawIcon(bitmap: ImageBitmap, box: number): HTMLCanvasElement {
  const size = fitIconSize(bitmap.width, bitmap.height, box);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を変換できませんでした");
  // canvas の既定は透明なので、透過 png に背景色は足さない
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * File を保存できる data URL にする。canvas の縮小とエンコードは DOM 依存で単体テストできないため、
 * この 1 箇所に閉じる。上限 (16 KiB) に収まらないときは品質 → 箱の順に落とす。
 */
export async function fileToAgentIcon(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("画像として読み込めませんでした。別のファイルを選んでください");
  }
  try {
    for (let box = AGENT_ICON_BOX; box >= MIN_BOX; box = Math.floor(box / 2)) {
      const dataUrl = await encodeIcon(drawIcon(bitmap, box));
      if (isAgentIcon(dataUrl)) return dataUrl;
    }
    throw new Error("16 KiB まで圧縮できませんでした。別の画像を選んでください");
  } finally {
    bitmap.close();
  }
}
