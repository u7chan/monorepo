/**
 * コストマスタ（`projects/cost-master`）の取得・検証・保持。価格と「一覧に出す / 出さない」の判断は
 * マスタが持ち、ここは読んで写すだけ。価格は選択の指標で、保存・試行・生成の判定には使わない。
 * 契約の正は docs/content-cost.md。
 */
import { lookup as resolveHostname } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { ContentCostCatalogModelRow, ContentCostCatalogRow, ContentCostSettingsRow } from "./app-db";

/** 上流の `unit` 語彙。これ以外の行は捨て、`0` へ丸めない */
export const COST_UNITS = ["image", "megapixel", "token", "character", "byte", "minute", "request"] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/** 入力 / 出力の区別。マスタの `billable` はここへ正規化してから DTO に載せる */
export const COST_SIDES = ["input", "output"] as const;
export type CostSide = (typeof COST_SIDES)[number];

const COST_BILLABLES = ["output_image", "input_text", "output_audio"] as const;

function isCostBillable(value: unknown): value is string {
  return typeof value === "string" && (COST_BILLABLES as readonly string[]).includes(value);
}

export function costSideOf(billable: string): CostSide {
  return billable.startsWith("input_") ? "input" : "output";
}

export const COST_MASTER_TIMEOUT_MS = 10_000;
/** URL が利用者入力なので、既存のカタログ取得と違い本文と行数に上限を置く */
export const COST_MASTER_MAX_BYTES = 1024 * 1024;
export const COST_MASTER_MAX_ROWS = 2_000;

/** 失敗分類。上流の本文・URL・接続先はログにも応答にも出さず、この固定文言へ寄せる */
export const COST_CATALOG_ERROR_TIMEOUT = "コストマスタの取得がタイムアウトしました";
export const COST_CATALOG_ERROR_RATE_LIMITED = "コストマスタの取得が混雑しています（レート制限またはサービス障害）";
export const COST_CATALOG_ERROR_UNKNOWN = "コストマスタを取得できませんでした";
export const COST_CATALOG_ERROR_BLOCKED = "コストマスタのURLが取得を許可されていない接続先を指しています";
export const COST_CATALOG_ERROR_CONTRACT = "コストマスタの応答が契約外です";
export const COST_CATALOG_ERROR_TOO_LARGE = "コストマスタの応答が大きすぎます";

export const CONTENT_COST_URL_REQUIRED_MESSAGE = "コストマスタのURLを入力してください";
export const CONTENT_COST_URL_INVALID_MESSAGE =
  "コストマスタのURLは http または https のホスト名で指定してください（IPアドレスと認証情報は使えません）";
export const CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE =
  "コストマスタの設定をアプリデータ（SQLite）へ保存できませんでした";

/** 応答へ載せる価格 1 件。`billable`（上流の語彙）はここへ持ち込まず、`side` に正規化する */
export interface CostPrice {
  unit: CostUnit;
  side: CostSide;
  variant: string;
  costUsd: number;
  currency: "USD";
}

/** モデルごとの表示用の投影。マスタに無いモデルは `prices: []` / `visible: true` / `note: null` */
export interface CostProjection {
  prices: CostPrice[];
  visible: boolean;
  note: string | null;
}

export interface CostSnapshot {
  /** 取得した時刻 (epoch ms) */
  fetchedAt: number;
  /** 取得元。設定の URL と一致しないスナップショットは使わない */
  sourceUrl: string;
  version: number | null;
  models: ContentCostCatalogModelRow[];
}

export interface ContentCostState {
  enabled: boolean;
  url: string | null;
  fetchedAt: number | null;
  version: number | null;
}

/** キャッシュの読み書きだけを注入し、取得側は DB を知らない */
export interface ContentCostStore {
  readContentCostSettings(): ContentCostSettingsRow | undefined;
  saveContentCostSettings(settings: ContentCostSettingsRow): void;
  deleteContentCostSettings(): boolean;
  readContentCostCatalog(): ContentCostCatalogRow | undefined;
  saveContentCostCatalog(row: ContentCostCatalogRow): void;
  deleteContentCostCatalog(): void;
}

export interface CostHttpResponse {
  status: number;
  text: string;
}

export type CostHttpOutcome = CostHttpResponse | { error: string };

export interface CostRequestOptions {
  timeoutMs: number;
  maxBytes: number;
  /** テストで差し替える DNS。既定は `dns/promises` の lookup（全 IP） */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /**
   * 接続先の検査の差し替え。既定は `isGlobalAddress`。本番で差し替えるのは
   * `PI_CONTENT_COST_ALLOW_PRIVATE` の opt-in のときだけ（`allowPrivateHosts` 経由）で、
   * 保存時と取得時の両方で接続先を制限する点は変えない。テストはループバックのサーバーへ繋ぐのに使う。
   */
  allowAddress?: (address: string) => boolean;
}

export interface ContentCostOptions {
  store: ContentCostStore;
  /** テストで差し替える取得。既定は接続先の検証・期限・上限つきの HTTP 取得 */
  fetchImpl?: (url: URL, options: CostRequestOptions) => Promise<CostHttpOutcome>;
  /** テストで固定する時計 */
  now?: () => number;
  timeoutMs?: number;
  /**
   * LAN / VPN の中でだけ到達できる master（同一 Docker ネットワークのサービス名など）を許可する opt-in。
   * 既定は false で、グローバルな接続先だけを通す。env の解釈は `allowPrivateCostHost()`。
   */
  allowPrivateHosts?: boolean;
}

export interface ContentCostCatalog {
  /** 起動時に 1 回だけ DB の設定とスナップショットを読む（外部へは出ない） */
  loadStored(): void;
  /** `cost` の投影。未設定・OFF でも保持している `fetchedAt` / `version` を返す */
  state(): ContentCostState;
  /** modelId → 価格 / 表示可否。OFF・未設定なら空（呼び出し側は全件を表示の既定にする） */
  projection(): Map<string, CostProjection>;
  saveSettings(input: {
    enabled: boolean;
    url: string;
  }): { status: 200 } | { status: 400; error: string } | { status: 503; error: string };
  /** ON かつ設定済みのときだけ取得する。失敗は固定文言を返し、前回値を残す（成功は null） */
  refresh(): Promise<string | null>;
}

function isCostUnit(value: unknown): value is CostUnit {
  return typeof value === "string" && (COST_UNITS as readonly string[]).includes(value);
}

/**
 * IPv4 / IPv6 がグローバル（インターネットから到達しうる）か。プライベート・ループバック・
 * リンクローカル・CGNAT・マルチキャスト・予約・ドキュメント用はすべて拒否する。
 */
export function isGlobalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isGlobalIpv4(address);
  if (version === 6) return isGlobalIpv6(address);
  return false;
}

function isGlobalIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // 192.0.0.0/24 (IETF) / 192.0.2.0/24 (TEST-NET-1) / 198.18.0.0/15 (benchmark) /
  // 198.51.100.0/24 (TEST-NET-2) / 203.0.113.0/24 (TEST-NET-3)
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

/** `::` を展開した 8 個の 16bit 群。IPv4 埋め込みは末尾 2 群として読む */
function ipv6Groups(address: string): number[] | undefined {
  const [head, tail, extra] = address.split("::");
  if (extra !== undefined) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const item of part.split(":")) {
      if (item === "") return undefined;
      if (item.includes(".")) {
        const version = isIP(item);
        if (version !== 4) return undefined;
        const octets = item.split(".").map((octet) => Number(octet));
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
          return undefined;
        }
        groups.push(((octets[0] as number) << 8) | (octets[1] as number));
        groups.push(((octets[2] as number) << 8) | (octets[3] as number));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(item)) return undefined;
      groups.push(Number.parseInt(item, 16));
    }
    return groups;
  };
  const left = parse(head ?? "");
  if (!left) return undefined;
  if (tail === undefined) return left.length === 8 ? left : undefined;
  const right = parse(tail);
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from<number>({ length: missing }).fill(0), ...right];
}

function isGlobalIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const [first, second] = groups as [number, number, ...number[]];
  // ::
  if (groups.every((group) => group === 0)) return false;
  // ::1
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  // IPv4-mapped (::ffff:0:0/96) は埋め込みの IPv4 として判定する
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isGlobalIpv4(v4);
  }
  // fc00::/7 (ULA)
  if ((first & 0xfe00) === 0xfc00) return false;
  // fe80::/10 (link-local)
  if ((first & 0xffc0) === 0xfe80) return false;
  // ff00::/8 (multicast)
  if ((first & 0xff00) === 0xff00) return false;
  // 2001:db8::/32 (documentation)
  if (first === 0x2001 && second === 0x0db8) return false;
  // 2001::/32 (Teredo) / 2002::/16 (6to4) / 64:ff9b::/96 (NAT64) は埋め込みの IPv4 で内部へ届きうる
  if (first === 0x2001 && second === 0) return false;
  if (first === 0x2002) return false;
  if (first === 0x0064 && second === 0xff9b) return false;
  return true;
}

/**
 * LAN / VPN の中でだけ到達できるアドレス（プライベート・CGNAT・ULA）。
 * ループバックとリンクローカルは含めない（master へ届かず、BFF 自身やメタデータへの経路になる）。
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  // IPv4-mapped (::ffff:0:0/96) は埋め込みの IPv4 として判定する
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPrivateIpv4(v4);
  }
  // fc00::/7 (ULA)
  return (groups[0]! & 0xfe00) === 0xfc00;
}

/** LAN / VPN 内の master をサービス名で指す環境でだけ true にする opt-in の env */
export const CONTENT_COST_ALLOW_PRIVATE_ENV = "PI_CONTENT_COST_ALLOW_PRIVATE";

/**
 * env の値を解釈する。未設定・未知の値は false（従来どおりグローバルだけを許可）へ倒す。
 * 接続先の制限は安全側の設定なので、設定ミスで緩まない向きに倒す（`networkAccessMode()` とは逆）。
 */
export function allowPrivateCostHost(raw: string | undefined = process.env[CONTENT_COST_ALLOW_PRIVATE_ENV]): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** 取得時に許可する接続先。opt-in のときだけ LAN 内向けを足す */
export function allowCostMasterAddress(address: string, allowPrivate: boolean): boolean {
  return isGlobalAddress(address) || (allowPrivate && isPrivateNetworkAddress(address));
}

/** `allowPrivateHosts` のときに `requestCostMaster()` へ渡す検査 */
const allowPrivateCostAddress = (address: string): boolean => allowCostMasterAddress(address, true);

/** URL のホストが IP リテラルか（IPv6 の角括弧を外して判定する） */
function isIpLiteralHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

/**
 * 保存時に見る URL の形。DNS 解決と SSRF 判定は取得時に行い、保存時に外部へ問い合わせない。
 * 空文字は呼び出し側が「行の削除」として扱うため、ここでは不正にしない。
 */
export function costUrlError(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return CONTENT_COST_URL_INVALID_MESSAGE;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return CONTENT_COST_URL_INVALID_MESSAGE;
  if (url.username !== "" || url.password !== "") return CONTENT_COST_URL_INVALID_MESSAGE;
  if (url.hostname === "" || isIpLiteralHost(url.hostname)) return CONTENT_COST_URL_INVALID_MESSAGE;
  return undefined;
}

/** マスタ応答の 1 行。`billable` は許可リストだけを通し、`side` に正規化する */
function costMasterRowsOf(body: unknown): { version: number | null; models: ContentCostCatalogModelRow[] } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { version, models } = body as { version?: unknown; models?: unknown };
  if (!Array.isArray(models) || models.length > COST_MASTER_MAX_ROWS) return undefined;
  if (version !== undefined && version !== null) {
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return undefined;
  }
  const rows: ContentCostCatalogModelRow[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null) continue;
    const { provider, modelId, billable, unit, variant, costUsd, currency, enabled, note } = item as Record<
      string,
      unknown
    >;
    // 単一 provider の版なので、違う provider の行は表示に混ぜない
    if (provider !== "openrouter") continue;
    if (typeof modelId !== "string" || modelId === "") continue;
    if (!isCostBillable(billable)) continue;
    if (!isCostUnit(unit)) continue;
    if (variant !== undefined && typeof variant !== "string") continue;
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) continue;
    if (currency !== "USD") continue;
    if (typeof enabled !== "boolean") continue;
    if (note !== undefined && note !== null && typeof note !== "string") continue;
    rows.push({
      modelId,
      unit,
      side: costSideOf(billable),
      variant: variant ?? "",
      costUsd,
      currency: "USD",
      enabled,
      note: note ?? null,
    });
  }
  return { version: typeof version === "number" ? version : null, models: dedupeCostRows(rows) };
}

/**
 * 同じ `(modelId, unit, side, variant)` を最大の単価へ潰す（マスタが endpoint を潰している前提の防御。
 * 配列順に依存させない）。モデル単位の `enabled` は false を優先し、`note` は入力順の先頭の非 null。
 */
function dedupeCostRows(rows: readonly ContentCostCatalogModelRow[]): ContentCostCatalogModelRow[] {
  const byPrice = new Map<string, ContentCostCatalogModelRow>();
  const byModel = new Map<string, { enabled: boolean; note: string | null }>();
  for (const row of rows) {
    const model = byModel.get(row.modelId);
    byModel.set(row.modelId, {
      enabled: (model?.enabled ?? true) && row.enabled,
      note: model?.note ?? row.note,
    });
    const key = `${row.modelId}\u0000${row.unit}\u0000${row.side}\u0000${row.variant}`;
    const previous = byPrice.get(key);
    if (previous === undefined || row.costUsd > previous.costUsd) byPrice.set(key, row);
  }
  return [...byPrice.values()]
    .map((row) => {
      const model = byModel.get(row.modelId);
      return model ? { ...row, enabled: model.enabled, note: model.note } : row;
    })
    .sort((a, b) =>
      a.modelId === b.modelId
        ? COST_UNITS.indexOf(a.unit as CostUnit) - COST_UNITS.indexOf(b.unit as CostUnit) ||
          COST_SIDES.indexOf(a.side) - COST_SIDES.indexOf(b.side) ||
          a.variant.localeCompare(b.variant)
        : a.modelId.localeCompare(b.modelId),
    );
}

/**
 * 保持したスナップショットをモデル単位の表示へ投影する。OFF / 未設定は空の map を返し、
 * 呼び出し側が全件を `prices: []` / `visible: true` / `note: null` にする（除外の層を 2 つにしない）。
 */
export function costProjectionOf(snapshot: CostSnapshot | undefined, enabled: boolean): Map<string, CostProjection> {
  const projection = new Map<string, CostProjection>();
  if (!enabled || snapshot === undefined) return projection;
  for (const row of snapshot.models) {
    const current = projection.get(row.modelId) ?? { prices: [], visible: row.enabled, note: row.note };
    if (row.enabled === false) current.visible = false;
    if (current.note === null && row.note !== null) current.note = row.note;
    if (isCostUnit(row.unit)) {
      const key = `${row.unit}\u0000${row.side}\u0000${row.variant}`;
      const existing = current.prices.findIndex(
        (price) => `${price.unit}\u0000${price.side}\u0000${price.variant}` === key,
      );
      const price: CostPrice = {
        unit: row.unit,
        side: row.side,
        variant: row.variant,
        costUsd: row.costUsd,
        currency: "USD",
      };
      if (existing === -1) current.prices.push(price);
      else if (price.costUsd > current.prices[existing]!.costUsd) current.prices[existing] = price;
    }
    projection.set(row.modelId, current);
  }
  return projection;
}

/** 既定の DNS 解決。すべての IP を一度だけ引き、その後の接続では再解決しない */
async function lookupAll(host: string): Promise<{ address: string; family: number }[]> {
  return (await resolveHostname(host, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
}

/**
 * 接続先を固定した GET。リダイレクトは追わず、認証ヘッダも付けず、本文と時間に上限を置く。
 * DNS は 1 回だけ引き、検証した IP へ接続する（再解決させると rebinding の窓が残る）。
 */
export async function requestCostMaster(url: URL, options: CostRequestOptions): Promise<CostHttpOutcome> {
  const lookup = options.lookup ?? lookupAll;
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(url.hostname);
  } catch {
    return { error: COST_CATALOG_ERROR_UNKNOWN };
  }
  const allow = options.allowAddress ?? isGlobalAddress;
  if (resolved.length === 0) return { error: COST_CATALOG_ERROR_BLOCKED };
  if (resolved.some((entry) => !allow(entry.address))) return { error: COST_CATALOG_ERROR_BLOCKED };

  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const requested =
      lookupOptions.family === 4 || lookupOptions.family === "IPv4"
        ? 4
        : lookupOptions.family === 6 || lookupOptions.family === "IPv6"
          ? 6
          : undefined;
    const candidates = requested === undefined ? resolved : resolved.filter((entry) => entry.family === requested);
    if (candidates.length === 0) {
      callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "");
      return;
    }
    if (lookupOptions.all) {
      callback(null, candidates);
      return;
    }
    const chosen = candidates[0]!;
    callback(null, chosen.address, chosen.family);
  };

  return await new Promise<CostHttpOutcome>((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let oversized = false;
    const finish = (outcome: CostHttpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        // 認証ヘッダは付けない。圧縮も要求しない（本文サイズの上限を素直に数える）
        headers: { accept: "application/json" },
        lookup: pinnedLookup,
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
          // Location を追わない。追うと検証済みの接続先の外へ出られる
          res.resume();
          finish({ status: res.statusCode, text: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            oversized = true;
            finish({ error: COST_CATALOG_ERROR_TOO_LARGE });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish({ error: COST_CATALOG_ERROR_UNKNOWN }));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      finish({ error: COST_CATALOG_ERROR_TIMEOUT });
      req.destroy();
    }, options.timeoutMs);
    req.on("error", () =>
      finish({
        error: timedOut
          ? COST_CATALOG_ERROR_TIMEOUT
          : oversized
            ? COST_CATALOG_ERROR_TOO_LARGE
            : COST_CATALOG_ERROR_UNKNOWN,
      }),
    );
    req.end();
  });
}

export function createContentCostCatalog(options: ContentCostOptions): ContentCostCatalog {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? COST_MASTER_TIMEOUT_MS;
  const fetchCost = options.fetchImpl ?? requestCostMaster;
  const allowAddress = options.allowPrivateHosts === true ? allowPrivateCostAddress : undefined;

  let settings: ContentCostSettingsRow | undefined;
  let snapshot: CostSnapshot | undefined;

  /** 前回値を捨てる。DB の削除に失敗してもメモリは捨て、次回の取得成功で上書きさせる */
  const dropSnapshot = (): void => {
    snapshot = undefined;
    try {
      store.deleteContentCostCatalog();
    } catch {
      console.warn("[u7agent] content cost cache delete failed");
    }
  };

  return {
    loadStored: () => {
      try {
        settings = store.readContentCostSettings();
      } catch (error) {
        console.warn(
          `[u7agent] content cost settings read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        settings = undefined;
      }
      snapshot = undefined;
      if (!settings) return;
      try {
        const stored = store.readContentCostCatalog();
        // 別マスタの値（URL 変更前のスナップショット）を現在値として出さない
        if (stored && stored.sourceUrl === settings.url) {
          snapshot = {
            fetchedAt: stored.fetchedAt,
            sourceUrl: stored.sourceUrl,
            version: stored.version,
            models: stored.models,
          };
        }
      } catch {
        console.warn("[u7agent] content cost cache unavailable");
      }
    },

    state: () => ({
      enabled: settings?.enabled ?? false,
      url: settings?.url ?? null,
      // OFF でも保持値を返す（画面が「停止中（前回取得: …）」を出せる）。未設定は null
      fetchedAt: settings ? (snapshot?.fetchedAt ?? null) : null,
      version: settings ? (snapshot?.version ?? null) : null,
    }),

    projection: () => costProjectionOf(snapshot, settings?.enabled ?? false),

    saveSettings: (input) => {
      const url = input.url.trim();
      if (url === "") {
        if (input.enabled) return { status: 400, error: CONTENT_COST_URL_REQUIRED_MESSAGE };
        // OFF + 空 URL は行の削除（未設定へ戻す）
        try {
          store.deleteContentCostSettings();
        } catch {
          return { status: 503, error: CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE };
        }
        settings = undefined;
        dropSnapshot();
        return { status: 200 };
      }
      const invalid = costUrlError(url);
      if (invalid) return { status: 400, error: invalid };
      let previous: ContentCostSettingsRow | undefined;
      try {
        previous = store.readContentCostSettings();
      } catch {
        return { status: 503, error: CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE };
      }
      try {
        store.saveContentCostSettings({ enabled: input.enabled, url });
      } catch {
        return { status: 503, error: CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE };
      }
      settings = { enabled: input.enabled, url };
      if (previous?.url !== url) dropSnapshot();
      return { status: 200 };
    },

    refresh: async () => {
      if (!settings || !settings.enabled) return null;
      // 手編集された行もここで形を再確認する（保存時の検証を迂回した値で外へ出ない）
      if (costUrlError(settings.url) !== undefined) return COST_CATALOG_ERROR_BLOCKED;
      let outcome: CostHttpOutcome;
      try {
        outcome = await fetchCost(new URL(settings.url), {
          timeoutMs,
          maxBytes: COST_MASTER_MAX_BYTES,
          ...(allowAddress === undefined ? {} : { allowAddress }),
        });
      } catch {
        outcome = { error: COST_CATALOG_ERROR_UNKNOWN };
      }
      if ("error" in outcome) {
        console.warn(`[u7agent] content cost fetch failed: ${outcome.error}`);
        return outcome.error;
      }
      if (outcome.status !== 200) {
        const error =
          outcome.status === 429 || outcome.status >= 500
            ? COST_CATALOG_ERROR_RATE_LIMITED
            : COST_CATALOG_ERROR_UNKNOWN;
        console.warn(`[u7agent] content cost fetch failed: ${error}`);
        return error;
      }
      let body: unknown;
      try {
        body = outcome.text === "" ? undefined : JSON.parse(outcome.text);
      } catch {
        body = undefined;
      }
      const parsed = costMasterRowsOf(body);
      if (!parsed) {
        console.warn(`[u7agent] content cost fetch failed: ${COST_CATALOG_ERROR_CONTRACT}`);
        return COST_CATALOG_ERROR_CONTRACT;
      }
      // 取得失敗のときは行を消さない・0 にしない。成功だけが前回値を置き換える
      const next: CostSnapshot = {
        fetchedAt: now(),
        sourceUrl: settings.url,
        version: parsed.version,
        models: parsed.models,
      };
      snapshot = next;
      try {
        store.saveContentCostCatalog(next);
      } catch {
        console.warn("[u7agent] content cost cache save failed");
      }
      return null;
    },
  };
}
