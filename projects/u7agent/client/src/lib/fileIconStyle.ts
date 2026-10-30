/**
 * ファイルツリー (FileBrowser) のアイコンの見た目。形と FileKind の分類は icons.tsx / lib/fileKind.ts が持ち、
 * ここは「どう色を載せるか」だけを決める。表示設定なので保存は localStorage の 1 キーに閉じる。
 * DOM に触れるのは保存先の解決だけ (docs/file-tree.md)。
 */

/** 選べる見た目。並びは設定画面の並びで、先頭が既定 */
export const FILE_ICON_STYLES = [
  { id: "line", label: "線", description: "現行と同じ単色。輪郭も模様も行の文字色に従う" },
  { id: "tint", label: "2 色", description: "輪郭は無彩色のまま、模様とフォルダにだけ色を載せる" },
  { id: "fill", label: "カラフル", description: "書類の面を種類色で塗り、模様を抜く" },
] as const;

export type FileIconStyle = (typeof FILE_ICON_STYLES)[number]["id"];

/** 未設定のときの見た目。既存の見た目を変えないため現行の線にする */
export const DEFAULT_FILE_ICON_STYLE: FileIconStyle = "line";

/** 保存キー。テーマ等と同じく端末ローカルの表示設定として持つ */
export const FILE_ICON_STYLE_KEY = "u7agent-file-icons";

/** 任意の値 (localStorage 等) が選べる見た目か */
export function isFileIconStyle(value: unknown): value is FileIconStyle {
  return FILE_ICON_STYLES.some((style) => style.id === value);
}

/**
 * 保存済みの生値を選べる見た目へ解決する。未保存と未知の値 (削除した見た目・手で書き換えた値) は
 * 既定へ倒し、保存値そのものは書き換えない (テーマの parseStoredThemeChoice と同じ扱い)。
 */
export function parseFileIconStyle(raw: string | null): FileIconStyle {
  return isFileIconStyle(raw) ? raw : DEFAULT_FILE_ICON_STYLE;
}

export type FileIconStyleStorage = Pick<Storage, "getItem" | "setItem">;

export type FileIconStyleStore = {
  /** 保存値 (未知の値は既定へ倒したもの) */
  read(): FileIconStyle;
  /** 選び直し。保存できなくても同じセッションの間は選んだ値を使う */
  write(style: FileIconStyle): void;
  /** 同じ画面の読み手へ変更を知らせる (設定画面で選んだ直後にツリーへ反映する) */
  subscribe(listener: () => void): () => void;
};

/**
 * 選んだ見た目を localStorage の 1 キーで読み書きする。保存領域が使えない環境 (private browsing 等) でも
 * 操作を止めず、代わりに同じセッション内のメモリを使う (fileTreeWidth.ts と同じ扱い)。
 */
export function createFileIconStyleStore(storage?: FileIconStyleStorage | null): FileIconStyleStore {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: FileIconStyle | undefined;
  const listeners = new Set<() => void>();
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolve = (): FileIconStyleStorage | null => (storage === undefined ? defaultStyleStorage() : storage);

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = resolve();
      if (!target) return DEFAULT_FILE_ICON_STYLE;
      try {
        return parseFileIconStyle(target.getItem(FILE_ICON_STYLE_KEY));
      } catch {
        return DEFAULT_FILE_ICON_STYLE;
      }
    },
    write(style) {
      memory = style;
      const target = resolve();
      if (target) {
        try {
          target.setItem(FILE_ICON_STYLE_KEY, style);
        } catch {
          // 保存できない。次に選び直したときにまた試す
        }
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** アプリが使う既定の store */
export const fileIconStyleStore = createFileIconStyleStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultStyleStorage(): FileIconStyleStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
