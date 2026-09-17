/**
 * ファイル画面の復元用 snapshot の encode / decode と、その保存先 (localStorage) の薄い境界。
 * 保存するのは「タブの並び / 表示中 / タブごとの表示モード / 開いているディレクトリ」だけで、
 * 本文・children・loading・error は持たない (他キーや複数 cwd と合算した容量と鮮度のため。
 * 復帰時は既存の取得経路で取り直す)。DOM に依存するのは保存先の解決だけ。
 */
import { FILE_TAB_LIMIT, type PreviewMode, type PreviewModes } from "./fileTabs";
import { FILE_TREE_ROOT, normalizeFileTreeRoot } from "./fileTree";

export const FILE_SNAPSHOT_KEY = "pi-agent-files";
export const FILE_SNAPSHOT_VERSION = 1;
/** 保存する cwd 数の上限。超えた分は先に書かれた cwd から落とす */
export const FILE_SNAPSHOT_CWD_LIMIT = 20;
/** cwd ごとの展開ディレクトリ数の上限 */
export const FILE_SNAPSHOT_DIR_LIMIT = 200;
/** 書き込み前の JSON の上限。超える書き込みは捨てる (既存キーと合算した容量を守る) */
export const FILE_SNAPSHOT_MAX_BYTES = 64 * 1024;

export type FilePreviewSnapshot = {
  /** 開いているタブ (root 相対・開いた順) */
  paths: string[];
  /** 表示中のタブ。タブが無ければ null */
  active: string | null;
  /** タブごとの表示モード。キーは paths の中だけ */
  modes: PreviewModes;
  /** 開いているディレクトリ (root 相対)。root は常に開いているので含めない */
  dirs: string[];
};

/** cwd (normalizeFileTreeRoot 済み) → snapshot */
export type FilePreviewSnapshots = Record<string, FilePreviewSnapshot>;

export function encodeFilePreviewSnapshots(snapshots: FilePreviewSnapshots): string {
  return JSON.stringify({ version: FILE_SNAPSHOT_VERSION, cwds: snapshots });
}

/**
 * 保存値を読む。JSON 全体が壊れているときだけ全体を捨て、形の合わない cwd は 1 件ずつ捨てる
 * (1 件の破損で他の cwd の復元まで諦めない)。
 */
export function decodeFilePreviewSnapshots(raw: string | null): FilePreviewSnapshots {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== FILE_SNAPSHOT_VERSION || !isRecord(parsed.cwds)) return {};
  const entries: [string, FilePreviewSnapshot][] = [];
  for (const [cwd, value] of Object.entries(parsed.cwds)) {
    const snapshot = parseFilePreviewSnapshot(value);
    if (snapshot) entries.push([cwd, snapshot]);
  }
  return Object.fromEntries(entries);
}

/** 1 cwd 分の検証。形が合わなければ null (呼び出し側がその cwd だけ捨てる) */
export function parseFilePreviewSnapshot(value: unknown): FilePreviewSnapshot | null {
  if (!isRecord(value)) return null;
  const paths = parsePaths(value.paths);
  if (!paths) return null;
  const { active } = value;
  // active は paths の中か null のどちらか (空のタブで active が残っている保存値は捨てる)
  if (active !== null && (typeof active !== "string" || !paths.includes(active))) return null;
  const modes = parseModes(value.modes, paths);
  if (!modes) return null;
  const dirs = parseDirectories(value.dirs);
  if (!dirs) return null;
  return { paths, active, modes, dirs };
}

/** 1 cwd 分を差し替えて返す (他 cwd を消さない merge)。null は「その cwd の保存を消す」 */
export function withFilePreviewSnapshot(
  snapshots: FilePreviewSnapshots,
  cwd: string,
  snapshot: FilePreviewSnapshot | null,
): FilePreviewSnapshots {
  const entries = Object.entries(snapshots).filter(([key]) => key !== cwd);
  // 保存する内容が無い snapshot は残しても読み手が何もしないため、cwd ごと消す (無制限増大を避ける)
  if (snapshot && (snapshot.paths.length > 0 || snapshot.dirs.length > 0)) entries.push([cwd, snapshot]);
  // 上限を超えたら先頭 (先に書かれた cwd) から落とす。今回書いた cwd は末尾なので残る
  return Object.fromEntries(entries.slice(-FILE_SNAPSHOT_CWD_LIMIT));
}

export type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

export type FilePreviewStore = {
  /** cwd の保存値。write が失敗した cwd はメモリ側が最新になる */
  read(cwd: string): FilePreviewSnapshot | null;
  /** snapshot を null にすると、その cwd の保存を消す */
  write(cwd: string, snapshot: FilePreviewSnapshot | null): void;
};

/**
 * cwd ごとの snapshot を localStorage の 1 キーで読み書きする。保存領域が使えない環境
 * (SecurityError / quota 超過) でも操作を止めず、無限リトライもしない。write が失敗した cwd は
 * メモリ snapshot が最新になるため、同一セッション内の往復 (設定を離れて戻る等) は復元できる。
 * ただし write 失敗後の F5 では古い保存値が戻り得る (復元は保証しない)。
 */
export function createFilePreviewStore(storage?: SnapshotStorage | null): FilePreviewStore {
  const memory = new Map<string, FilePreviewSnapshot | null>();
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolveStorage = (): SnapshotStorage | null => (storage === undefined ? defaultSnapshotStorage() : storage);

  return {
    read(cwd) {
      const key = normalizeFileTreeRoot(cwd);
      if (memory.has(key)) return memory.get(key) ?? null;
      const target = resolveStorage();
      if (!target) return null;
      try {
        const snapshots = decodeFilePreviewSnapshots(target.getItem(FILE_SNAPSHOT_KEY));
        return Object.hasOwn(snapshots, key) ? (snapshots[key] ?? null) : null;
      } catch {
        return null;
      }
    },
    write(cwd, snapshot) {
      const key = normalizeFileTreeRoot(cwd);
      // メモリ側は常に最新にする (保存できなくても同一セッション内の往復は復元できる)
      memory.set(key, snapshot);
      const target = resolveStorage();
      if (!target) return;
      // 読み手 (decode) が捨てる形は書かない。書くと次の起動でその cwd のタブもモードも失われる
      if (snapshot && !parseFilePreviewSnapshot(snapshot)) return;
      try {
        // 他 cwd を消さない read-modify-write
        const raw = target.getItem(FILE_SNAPSHOT_KEY);
        const text = encodeFilePreviewSnapshots(
          withFilePreviewSnapshot(decodeFilePreviewSnapshots(raw), key, snapshot),
        );
        if (text === raw) return;
        if (new TextEncoder().encode(text).length > FILE_SNAPSHOT_MAX_BYTES) return;
        target.setItem(FILE_SNAPSHOT_KEY, text);
      } catch {
        // 保存領域が使えない。次の変更でまた試す (ここでは再試行しない)
      }
    },
  };
}

/** アプリが使う既定の store (localStorage + cwd ごとのメモリ snapshot) */
export const filePreviewStore = createFilePreviewStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultSnapshotStorage(): SnapshotStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parsePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > FILE_TAB_LIMIT) return null;
  const paths = value.filter((path): path is string => typeof path === "string" && path !== "");
  // 重複と空文字を許さない (タブは同じパスを 2 枚持てない)
  if (paths.length !== value.length || new Set(paths).size !== paths.length) return null;
  return paths;
}

function parseModes(value: unknown, paths: string[]): PreviewModes | null {
  if (!isRecord(value)) return null;
  const entries: [string, PreviewMode][] = [];
  for (const [path, mode] of Object.entries(value)) {
    // 選択はタブを閉じるまで保持するため、開いていないタブのモードは残さない
    if (!paths.includes(path)) return null;
    if (mode !== "source" && mode !== "preview") return null;
    entries.push([path, mode]);
  }
  // cwd map と同じく own property として組む (`__proto__` のような名前を往復させる)
  return Object.fromEntries(entries);
}

function parseDirectories(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > FILE_SNAPSHOT_DIR_LIMIT) return null;
  const dirs = value.filter((path): path is string => typeof path === "string");
  if (dirs.length !== value.length || new Set(dirs).size !== dirs.length) return null;
  if (dirs.some((path) => !isDirectoryPath(path))) return null;
  return dirs;
}

/** root 相対のディレクトリパスとして妥当か。root (".") と空文字は保存しない */
function isDirectoryPath(path: string): boolean {
  if (path === "" || path === FILE_TREE_ROOT || path.startsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
