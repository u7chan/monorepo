/**
 * 左バーのセッション行の表示規則 (いま動いている / 未見の結果がある / どちらでもない) と、
 * 既読 (seen) の run id を端末ローカルへ持つストア。DOM に触れるのは保存先の解決だけで、
 * 見た目のクラスは SessionRow が持つ。
 *
 * 未見の判定は seen ストアだけを正とし、サーバーの status からは推測しない (再起動で status は
 * idle に戻り、SWEEP で record が消えても `meta.lastRun` が残るため。表示の寿命はメモリの寿命と別)。
 */
import type { RunStatus, SessionSummary } from "../types";

/** 行に出す状態の語彙。queued は 200ms の遷移なので running へ畳む (API の status は変えない) */
export type SidebarStatusWord = "running" | "compacting" | "completed" | "stopped" | "error" | "";

/** ドットの種類。クラスは SessionRow がこの値から引く */
export type SidebarTone = "accent" | "ok" | "warn" | "danger" | "idle";

export type SidebarStatus = {
  word: SidebarStatusWord;
  /** 行に出すラベル。idle は空文字 (ラベルを出さない) */
  label: string;
  tone: SidebarTone;
};

const TERMINAL_LABELS = { completed: "完了", stopped: "停止", error: "エラー" } as const;
const TERMINAL_TONES = { completed: "ok", stopped: "warn", error: "danger" } as const;

/** ラベルもドットも出さない行 (未見なし) */
const IDLE_STATUS: SidebarStatus = { word: "", label: "", tone: "idle" };

type SidebarRowInput = Pick<SessionSummary, "sessionId" | "status" | "lastRun">;

/**
 * 行の表示を導出する。優先順位は live > 未見 > idle で、live は常に出す (実行中の行を
 * 未見のラベルで隠さない)。終端は seen に無いときだけ未見として出し、`lastRun.status` を
 * 使う (live な record でも再起動後は `status` が idle になるため)
 */
export function sidebarStatus(item: SidebarRowInput, seen: ReadonlyMap<string, readonly string[]>): SidebarStatus {
  if (item.status === "compacting") return { word: "compacting", label: "圧縮中", tone: "accent" };
  if (item.status === "running" || item.status === "queued") {
    return { word: "running", label: "実行中", tone: "accent" };
  }
  const lastRun = item.lastRun;
  if (!lastRun || isRunSeen(seen, item.sessionId, lastRun.id)) return IDLE_STATUS;
  return { word: lastRun.status, label: TERMINAL_LABELS[lastRun.status], tone: TERMINAL_TONES[lastRun.status] };
}

/** 終端の status か。既読にする run を選ぶ判定に使う */
export function isTerminalRunStatus(status: RunStatus): status is "completed" | "stopped" | "error" {
  return status === "completed" || status === "stopped" || status === "error";
}

/**
 * 既読にしてよい run の id。終端のときだけ返す (実行中の結果を先に既読にしない)。
 * `run_end` のように runId が無い経路があるため undefined を受ける
 */
export function endedRunId(run: { id: string; status: RunStatus } | null | undefined): string | undefined {
  if (!run || !isTerminalRunStatus(run.status)) return undefined;
  return run.id;
}

/** 会話 id -> 既読の run id (古い順、末尾が最新) */
export type SeenRuns = Map<string, string[]>;

export function isRunSeen(
  state: ReadonlyMap<string, readonly string[]>,
  sessionId: string,
  runId: string | undefined,
): boolean {
  if (!sessionId || !runId) return false;
  return state.get(sessionId)?.includes(runId) === true;
}

/** 保存キー。テーマ等と同じく端末ローカルの表示状態として持つ */
export const SEEN_RUNS_KEY = "u7agent-seen-runs";
export const SEEN_RUNS_VERSION = 1;
/** 会話あたりに残す run id の数。超えた分は古い方 (先頭) から落とす */
export const SEEN_RUNS_PER_SESSION_LIMIT = 8;
/** 残す会話の数。超えた分は先に既読にした会話から落とす (落ちた会話は未見が復活し得る無害側) */
export const SEEN_RUNS_SESSION_LIMIT = 500;

export function encodeSeenRuns(state: ReadonlyMap<string, readonly string[]>): string {
  return JSON.stringify({
    version: SEEN_RUNS_VERSION,
    sessions: [...state].map(([sessionId, runIds]) => ({ sessionId, runIds: [...runIds] })),
  });
}

/** 保存値を読む。JSON 全体 / version が合わなければ捨て、形の合わない会話は 1 件ずつ落とす */
export function decodeSeenRuns(raw: string | null): SeenRuns {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!isRecord(parsed) || parsed.version !== SEEN_RUNS_VERSION || !Array.isArray(parsed.sessions)) return new Map();
  const state: SeenRuns = new Map();
  for (const value of parsed.sessions) {
    if (!isRecord(value)) continue;
    const sessionId = value.sessionId;
    if (typeof sessionId !== "string" || sessionId === "" || state.has(sessionId)) continue;
    const runIds = parseRunIds(value.runIds);
    if (runIds.length === 0) continue;
    state.set(sessionId, runIds);
  }
  return capSeenSessions(state);
}

/** run id の和集合 (base → add の順、重複は先勝ち)。上限を超えた分は古い方から落とす */
export function unionRunIds(base: readonly string[], add: readonly string[]): string[] {
  const runIds: string[] = [];
  const known = new Set<string>();
  for (const runId of [...base, ...add]) {
    if (typeof runId !== "string" || runId === "" || known.has(runId)) continue;
    known.add(runId);
    runIds.push(runId);
  }
  return runIds.slice(-SEEN_RUNS_PER_SESSION_LIMIT);
}

/**
 * `add` を `base` へ和集合で足す。既読にした run が同じときは同じ参照を返し、呼び出し側の
 * 再描画と保存 (read-modify-write) を起こさない。更新した会話は末尾へ移す (会話の上限は
 * 「最近既読にした会話を残す」で切る)
 */
export function mergeSeenRuns(base: SeenRuns, add: ReadonlyMap<string, readonly string[]>): SeenRuns {
  if (add.size === 0) return base;
  const entries = [...base];
  let changed = false;
  for (const [sessionId, runIds] of add) {
    if (typeof sessionId !== "string" || sessionId === "") continue;
    const index = entries.findIndex(([id]) => id === sessionId);
    const current = index >= 0 ? entries[index][1] : [];
    const next = unionRunIds(current, runIds);
    if (sameRunIds(next, current)) continue;
    if (index >= 0) entries.splice(index, 1);
    entries.push([sessionId, next]);
    changed = true;
  }
  return changed ? capSeenSessions(new Map(entries)) : base;
}

/**
 * `base` (保存値) を土台に、`add` (メモリ) の既読を上限の空きがある分だけ足す。`mergeSeenRuns` と
 * 違い、**土台の既読は落とさない**。上限の空きが無い会話 / 会話数の上限に達した分は捨てる
 * (add の新しい方を残す)。書き戻しが保存値を単調に増やすだけになるため、2 タブの write が
 * 重なっても書き直しが止まる (上限に達した会話は土台のままになる)
 */
export function mergeKeepingStored(base: SeenRuns, add: ReadonlyMap<string, readonly string[]>): SeenRuns {
  if (add.size === 0) return base;
  const entries = [...base];
  let changed = false;
  for (const [sessionId, runIds] of add) {
    if (typeof sessionId !== "string" || sessionId === "") continue;
    const index = entries.findIndex(([id]) => id === sessionId);
    if (index === -1) {
      // 会話数の上限に達したら新しい会話は足さない (土台を消さない)
      if (entries.length >= SEEN_RUNS_SESSION_LIMIT) continue;
      const next = unionRunIds([], runIds);
      if (next.length === 0) continue;
      entries.push([sessionId, next]);
      changed = true;
      continue;
    }
    const current = entries[index][1];
    const room = SEEN_RUNS_PER_SESSION_LIMIT - current.length;
    if (room <= 0) continue;
    const known = new Set(current);
    const extras = runIds.filter((runId) => runId !== "" && !known.has(runId));
    // 空きより多い分は古い方を捨てる (Issue の「新しい順に残す」)
    const appended = extras.slice(-room);
    if (appended.length === 0) continue;
    entries[index] = [sessionId, [...current, ...appended]];
    changed = true;
  }
  return changed ? new Map(entries) : base;
}

export type SeenStorageEvent = { key: string | null; newValue: string | null };

/** 並びまで同じか (上限に達した後は、長さが同じでも中身が入れ替わる) */
function sameRunIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((runId, index) => runId === b[index]);
}

/**
 * 別タブの書込みを取り込む。合流のみで置換しない (別タブが既読にした別の会話を消さない)。
 * `key === null` (clear()) / `newValue === null` (removeItem) はマージできる値が無いので、
 * 手元の既読をそのまま保つ
 */
export function applySeenStorageEvent(state: SeenRuns, event: SeenStorageEvent): SeenRuns {
  if (event.key !== SEEN_RUNS_KEY || event.newValue === null) return state;
  return mergeSeenRuns(state, decodeSeenRuns(event.newValue));
}

export type SeenRunsStorage = Pick<Storage, "getItem" | "setItem">;

/** `window` の storage イベント購読に必要な部分 (テストでは差し替える) */
export type SeenRunsEventTarget = {
  addEventListener(type: "storage", listener: (event: SeenStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: SeenStorageEvent) => void): void;
};

export type SeenRunsStore = {
  /** 現在の既読。変更が無い限り同じ参照を返す (useSyncExternalStore の snapshot) */
  snapshot(): SeenRuns;
  subscribe(listener: () => void): () => void;
  /** run id を既読にする。保存値は読み直してから和集合で合流して書く (read-modify-write) */
  mark(sessionId: string, runId: string | undefined): void;
};

/**
 * 既読の run id を localStorage の 1 キーで読み書きする。write は必ず保存値を読み直し、
 * 保存値の既読を落とさない合流 (`mergeKeepingStored`) で書き戻す (新しい run を mark したときだけ、
 * 上限のため古い既読を落とす)。メモリのそのまま書きは 2 タブが別々の会話を既読にしたときに片方を
 * 落とし、無条件の書き戻しは上限に達した会話でタブ間の書き直しが止まらなくなる。1 タブ内のメモリは
 * read のキャッシュとして持ち、別タブの write は storage イベントで合流する。保存領域が使えない環境
 * (private browsing 等) はメモリだけへフォールバックする。
 */
export function createSeenRunsStore(
  storage?: SeenRunsStorage | null,
  events?: SeenRunsEventTarget | null,
): SeenRunsStore {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: SeenRuns | undefined;
  const listeners = new Set<() => void>();
  let detachEvents: (() => void) | undefined;
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolveStorage = (): SeenRunsStorage | null => (storage === undefined ? defaultSeenStorage() : storage);
  const resolveEvents = (): SeenRunsEventTarget | null => (events === undefined ? defaultSeenEvents() : events);

  const readStored = (): SeenRuns => {
    const target = resolveStorage();
    if (!target) return new Map();
    try {
      return decodeSeenRuns(target.getItem(SEEN_RUNS_KEY));
    } catch {
      return new Map();
    }
  };
  const state = (): SeenRuns => (memory ??= readStored());
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  /**
   * 保存値とメモリを合流させ、足りない既読を保存値へ書き戻す。合流は `mergeKeepingStored`
   * (保存値の既読を落とさない) に限るので、書き込みは保存値の内容が増えるときだけ起きる。
   * `evict: true` は mark が新しい run を足したときだけで、上限のため古い既読を落とす。
   * 書き込みが成功していれば、終わったあとのメモリと保存値の内容は一致する (次の合流で
   * 書き直しが起きない)。メモリの内容が変わったら true を返す
   */
  const converge = ({ evict = false }: { evict?: boolean } = {}): boolean => {
    const target = resolveStorage();
    const previous = state();
    if (!target) return false;
    let stored: SeenRuns;
    try {
      stored = decodeSeenRuns(target.getItem(SEEN_RUNS_KEY));
    } catch {
      return false;
    }
    const merged = evict ? mergeSeenRuns(stored, previous) : mergeKeepingStored(stored, previous);
    const changed = !sameSeenRuns(merged, previous);
    if (changed) memory = merged;
    if (sameSeenRuns(stored, merged)) return changed;
    try {
      target.setItem(SEEN_RUNS_KEY, encodeSeenRuns(merged));
    } catch {
      // 保存できない。次の mark / イベントでまた試す (ここでは再試行しない)
    }
    return changed;
  };
  const attachEvents = (): void => {
    const target = resolveEvents();
    if (!target) return;
    const handler = (event: SeenStorageEvent): void => {
      const previous = state();
      const next = applySeenStorageEvent(previous, event);
      if (next !== previous) memory = next;
      // 取り込んだだけでは、競合した write で保存値に残った片方しか直らない。合流結果で収束させる
      if (converge() || next !== previous) notify();
    };
    target.addEventListener("storage", handler);
    detachEvents = () => target.removeEventListener("storage", handler);
  };

  return {
    snapshot: state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        attachEvents();
        // 購読が外れている間の別タブの既読を取り込む (overlay 配置ではドロワーを閉じると Sidebar が
        // unmount し、listener も外れるため、購読時に保存値を読み直さないと取りこぼす)
        if (converge()) notify();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        detachEvents?.();
        detachEvents = undefined;
      };
    },
    mark(sessionId, runId) {
      if (!sessionId || !runId) return;
      const before = state();
      const added = !isRunSeen(before, sessionId, runId);
      // 新しい run は上限のため古い既読を落としてでも保存する。既読の run の mark は、
      // 別タブの write と重なって保存値から落ちていないかを確かめるだけ (落とさない合流)
      if (added) memory = mergeSeenRuns(before, new Map([[sessionId, [runId]]]));
      if (converge({ evict: added }) || memory !== before) notify();
    },
  };
}

/** アプリが使う既定の store */
export const seenRunsStore = createSeenRunsStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultSeenStorage(): SeenRunsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultSeenEvents(): SeenRunsEventTarget | null {
  try {
    return typeof window === "undefined" ? null : window;
  } catch {
    return null;
  }
}

function capSeenSessions(state: SeenRuns): SeenRuns {
  if (state.size <= SEEN_RUNS_SESSION_LIMIT) return state;
  return new Map([...state].slice(-SEEN_RUNS_SESSION_LIMIT));
}

function parseRunIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unionRunIds([], value);
}

/** 内容が同じか (会話の並び順は見ない)。書き直しと再描画を無駄に起こさないための比較 */
function sameSeenRuns(a: ReadonlyMap<string, readonly string[]>, b: ReadonlyMap<string, readonly string[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [sessionId, runIds] of a) {
    const other = b.get(sessionId);
    if (!other || !sameRunIds(runIds, other)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
