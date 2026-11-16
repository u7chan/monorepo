import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MASTER_KINDS, type MasterKind } from "../shared/contract";
import type { MasterState } from "./app";
import { buildPayload, parseJudgmentFile, parsePriceFile, type DroppedRow } from "./master";

export type ReplaceResult = { ok: true; state: MasterState } | { ok: false; reason: string };

export type MasterStore = {
  /** volume が空のとき、image に同梱した初期値をコピーする */
  ensureSeed: () => void;
  /** リクエストごとに呼ぶ。mtime とサイズが変わっていなければ前回の結果を返す */
  state: () => MasterState;
  /** 画面からのダウンロード用。読めなければ null */
  raw: (kind: MasterKind) => string | null;
  /** 検証してから原子的に置き換え、直前の内容を 1 世代だけ残す */
  replace: (kind: MasterKind, text: string) => ReplaceResult;
};

export function createMasterStore(input: {
  dir: string;
  bundledDir: string;
  log: (line: string) => void;
}): MasterStore {
  let cache: { key: string; state: MasterState } | null = null;

  const pathOf = (kind: MasterKind): string => join(input.dir, `${kind}.json`);
  const backupOf = (kind: MasterKind): string => `${pathOf(kind)}.bak`;

  function ensureSeed(): void {
    mkdirSync(input.dir, { recursive: true });

    const present = MASTER_KINDS.filter((kind) => existsSync(pathOf(kind)));

    if (present.length === MASTER_KINDS.length) {
      return;
    }

    // 片方だけある volume を「空」と見なすと、消した判断を image の初期値で黙って上書きする
    if (present.length > 0) {
      input.log(`マスタが一部だけあります（${present.join(", ")}）。image からのコピーはしません`);
      return;
    }

    for (const kind of MASTER_KINDS) {
      copyFileSync(join(input.bundledDir, `${kind}.json`), pathOf(kind));
      input.log(`マスタを image からコピーしました: ${kind}.json`);
    }
  }

  function readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  function statKey(): string {
    return MASTER_KINDS.map((kind) => {
      try {
        const stat = statSync(pathOf(kind));

        return `${kind}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${kind}:missing`;
      }
    }).join("|");
  }

  function parseState(): MasterState {
    const parsed = parseMaster(readText(pathOf("prices")), readText(pathOf("enabled")));

    // 起動時は行を落として既定へ倒す。黙って落とすと「隠したつもりが隠れていない」に気付けない
    for (const dropped of parsed.dropped) {
      input.log(`マスタの行を落としました: ${dropped.modelId || "(no modelId)"} (${dropped.reason})`);
    }

    return parsed.state;
  }

  return {
    ensureSeed,

    state(): MasterState {
      const key = statKey();

      if (cache !== null && cache.key === key) {
        return cache.state;
      }

      const state = parseState();
      cache = { key, state };

      return state;
    },

    raw(kind: MasterKind): string | null {
      return readText(pathOf(kind));
    },

    replace(kind: MasterKind, text: string): ReplaceResult {
      const value = tryParse(text);

      if (value === undefined) {
        return { ok: false, reason: "json" };
      }

      const invalid = validate(kind, value);

      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }

      // 片方だけ差し替えて全体が読めなくなるなら反映しない（「反映したのに 503」を作らない）
      const preview = parseMaster(
        kind === "prices" ? text : readText(pathOf("prices")),
        kind === "enabled" ? text : readText(pathOf("enabled")),
      );

      if (!preview.state.ok) {
        return { ok: false, reason: "master" };
      }

      const path = pathOf(kind);
      const temp = `${path}.tmp`;

      writeFileSync(temp, text.endsWith("\n") ? text : `${text}\n`);

      if (existsSync(path)) {
        copyFileSync(path, backupOf(kind));
      }

      renameSync(temp, path);
      cache = null;

      return { ok: true, state: preview.state };
    },
  };
}

type ParsedMaster = { state: MasterState; dropped: DroppedRow[] };

/** アップロードは人の明示操作なので、起動時の読み込みと違って 1 行でも不正なら全体を拒否する */
function parseMaster(pricesText: string | null, enabledText: string | null): ParsedMaster {
  const unavailable: ParsedMaster = { state: { ok: false }, dropped: [] };
  const prices = pricesText === null ? undefined : tryParse(pricesText);

  if (prices === undefined) {
    return unavailable;
  }

  const parsedPrices = parsePriceFile(prices);

  if (!parsedPrices.ok) {
    return unavailable;
  }

  const enabled = enabledText === null ? undefined : tryParse(enabledText);

  if (enabled === undefined) {
    return unavailable;
  }

  const parsedJudgments = parseJudgmentFile(enabled);

  if (!parsedJudgments.ok) {
    return unavailable;
  }

  return {
    state: {
      ok: true,
      payload: buildPayload({
        version: parsedPrices.version,
        fetchedAt: parsedPrices.fetchedAt,
        rows: parsedPrices.rows,
        judgments: parsedJudgments.rows,
      }),
    },
    dropped: [...parsedPrices.dropped, ...parsedJudgments.dropped],
  };
}

function validate(kind: MasterKind, value: unknown): string | null {
  if (kind === "prices") {
    const parsed = parsePriceFile(value);

    if (!parsed.ok) {
      return parsed.reason;
    }

    return parsed.dropped.length === 0 ? null : "rows";
  }

  const parsed = parseJudgmentFile(value);

  if (!parsed.ok) {
    return parsed.reason;
  }

  return parsed.dropped.length === 0 ? null : "rows";
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
