/**
 * QR の最小単位。描画側はモジュールの一辺だけを持ち、余白（quiet zone）は自分で足す
 * （QR の仕様上、白地の余白が無いとカメラが読み取れない）。
 */
import qrcode from "qrcode-generator";

/** 四周に確保する余白。QR の規格が求める 4 モジュール */
export const QR_QUIET_ZONE_MODULES = 4;

// 誤り訂正 M は URL 用途の標準的な選択。version は URL の長さに合わせて自動にする
const QR_ERROR_CORRECTION = "M";

export type QrCode = {
  /** 余白を含まない一辺のモジュール数 */
  size: number;
  /** `modules[row][column]`。true が黒 */
  modules: boolean[][];
};

/**
 * URL から QR のモジュールを作る。長すぎる URL などで生成できないときは例外を投げず `null`
 * （呼び出し側は QR を出さず、URL とコピーだけを残す）。
 */
export function qrCodeModules(url: string): QrCode | null {
  if (url === "") return null;
  try {
    const qr = qrcode(0, QR_ERROR_CORRECTION);
    qr.addData(url);
    qr.make();
    const size = qr.getModuleCount();
    return {
      size,
      modules: Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, column) => qr.isDark(row, column)),
      ),
    };
  } catch {
    return null;
  }
}

/** SVG の viewBox に使う一辺。quiet zone を含めたモジュール数 */
export function qrCodeViewSize(size: number): number {
  return size + QR_QUIET_ZONE_MODULES * 2;
}

/** 黒モジュールを 1 本の path にまとめる。座標は quiet zone の分だけずらす */
export function qrCodePath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + QR_QUIET_ZONE_MODULES} ${y + QR_QUIET_ZONE_MODULES}h1v1h-1z`);
    });
  });
  return parts.join("");
}
