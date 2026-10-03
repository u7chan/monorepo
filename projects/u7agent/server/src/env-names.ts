/**
 * 環境変数名 (作業環境 → 環境変数 の「名前」) の規則。登録時の検証 (BFF) と注入時の防御 (サンドボックス) が
 * 同じ表を使うため、依存を持たないこのモジュールへ置く。値の規則は secrets.ts、設計は docs/secrets.md を正とする。
 */

/** 正規化後の長さの上限 */
export const ENV_NAME_MAX_LENGTH = 64;

/** 予約プレフィックス。アプリ / サンドボックスの制御に使う名前空間はユーザーへ開放しない */
export const RESERVED_ENV_PREFIXES: readonly string[] = ["PI_", "PI_SANDBOX_", "U7AGENT_"];

/**
 * 実行制御に関わる名前。値はエージェントの bash とサービスへ渡るため、注入を許すと起動経路そのものを
 * 差し替えられる (PATH の解決、shell 起動時のスクリプト読み込みなど)。名前で拒否する。
 */
export const RESERVED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "BASH_ENV",
  "IFS",
  "SHELLOPTS",
  "PS4",
];

/** ブラウザのバンドルへ値を埋め込むスタックの接頭辞。シークレットでは登録を拒否する */
export const PUBLIC_ENV_PREFIXES: readonly string[] = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", "PUBLIC_"];

/** 正規化後 (大文字) の使用可能文字。先頭の数字は不可 */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** 入力の前後空白を落として大文字へ畳む。保存・一意性判定・注入・表示をこの 1 つへ揃える */
export function normalizeEnvName(raw: string): string {
  return raw.trim().toUpperCase();
}

/** ブラウザのバンドルへ入る接頭辞か (シークレットでだけ拒否する) */
export function isPublicEnvName(name: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || RESERVED_ENV_NAMES.includes(name);
}

/**
 * 使えない名前の理由 (人間向け)。使えるときは undefined。
 * 正規化後の名前を受ける (trim / 大文字化は呼び出し側の入口で 1 回だけ行う)。
 */
export function envNameProblem(name: string): string | undefined {
  if (name.length === 0) return "名前を入力してください";
  if (name.length > ENV_NAME_MAX_LENGTH) return `名前は ${ENV_NAME_MAX_LENGTH} 文字以内にしてください`;
  if (!ENV_NAME_PATTERN.test(name)) {
    return "名前に使えるのは半角英数字と _ だけで、先頭は英字か _ にしてください";
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `${name} は予約された接頭辞 (${RESERVED_ENV_PREFIXES.join(" / ")}) のため使えません`;
  }
  if (RESERVED_ENV_NAMES.includes(name)) return `${name} は起動経路を変えるため使えません`;
  return undefined;
}

/**
 * サンドボックスが注入を受け付けてよい名前か。正規化後 (大文字) の名前を受ける前提で、
 * 予約名 / 起動制御名も拒否する (BFF を経由しない呼び出しへの防御)。
 */
export function isInjectableEnvName(name: string): boolean {
  return name.length <= ENV_NAME_MAX_LENGTH && ENV_NAME_PATTERN.test(name) && !isReservedEnvName(name);
}
