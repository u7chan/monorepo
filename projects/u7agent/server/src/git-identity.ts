/**
 * Git の identity (`user.name` / `user.email`) の値の規則と、サンドボックスへ書く INI の組み立て。
 * BFF の設定 API とサンドボックスの実体が同じ表を使うため、依存を持たないこのモジュールへ置く。
 * 設計は docs/sandbox.md の「Git identity」を正とする。
 */

/** `user.name` の上限 (文字数)。git は長さを制限しないが、UI と INI の行を有限に保つ */
export const GIT_USER_NAME_MAX_LENGTH = 100;
/** `user.email` の上限 (文字数)。RFC 5321 の path 上限に合わせる */
export const GIT_USER_EMAIL_MAX_LENGTH = 254;

/** 保存・サンドボックスへ渡す identity。両方揃っているときだけ有効 */
export interface GitIdentity {
  userName: string;
  userEmail: string;
}

/** 制御文字・NUL・改行は INI の行構造と子プロセスの env を壊すため、値として受け付けない */
// oxlint-disable-next-line no-control-regex -- INI の行構造と子プロセスの env を壊す値を意図的に検出する
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** `<` `>` は git の identity の区切りとして解釈され、表示も壊れるため拒否する */
const ANGLE_BRACKETS = /[<>]/;
/** 簡易形状検証。RFC 全体は見ず、`@` と `.` を挟んだ 1 行だけを通す */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GitIdentityInput {
  userName?: unknown;
  userEmail?: unknown;
}

/**
 * 保存できない理由 (人間向け)。使えるときは undefined。
 * 前後の空白は落とした値で判定する (保存値も同じ正規化を使う)。
 */
export function gitIdentityProblem(input: GitIdentityInput): string | undefined {
  const rawName = typeof input.userName === "string" ? input.userName : "";
  const rawEmail = typeof input.userEmail === "string" ? input.userEmail : "";
  // 制御文字は前後の空白として黙って落とさず、入力のまま拒否する (保存値と表示の食い違いを作らない)
  if (CONTROL_CHARACTERS.test(rawName) || CONTROL_CHARACTERS.test(rawEmail)) {
    return "Git の名前とメールアドレスに制御文字や改行は使えません";
  }
  if (ANGLE_BRACKETS.test(rawName) || ANGLE_BRACKETS.test(rawEmail)) {
    return "Git の名前とメールアドレスに < と > は使えません";
  }
  const userName = rawName.trim();
  const userEmail = rawEmail.trim();
  if (!userName) return "Git の名前を入力してください";
  if (!userEmail) return "Git のメールアドレスを入力してください";
  if (userName.length > GIT_USER_NAME_MAX_LENGTH) {
    return `Git の名前は ${GIT_USER_NAME_MAX_LENGTH} 文字以内にしてください`;
  }
  if (userEmail.length > GIT_USER_EMAIL_MAX_LENGTH) {
    return `Git のメールアドレスは ${GIT_USER_EMAIL_MAX_LENGTH} 文字以内にしてください`;
  }
  if (!EMAIL_SHAPE.test(userEmail)) return "Git のメールアドレスの形式が正しくありません";
  return undefined;
}

/** 値を INI の quoted value にする。制御文字は入口で拒否済みなので、区切りになる 2 文字だけを逃がす */
export function gitConfigQuotedValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * サンドボックスの `GIT_CONFIG_GLOBAL` に書く内容。`useConfigOnly` は未設定のときに git の
 * 自動推測 (`user@host`) で仮 identity を作らせないための固定行で、identity の有無に関わらず書く。
 */
export function gitConfigText(identity: GitIdentity | null): string {
  if (!identity) return "[user]\n\tuseConfigOnly = true\n";
  return [
    "[user]",
    `\tname = ${gitConfigQuotedValue(identity.userName)}`,
    `\temail = ${gitConfigQuotedValue(identity.userEmail)}`,
    "\tuseConfigOnly = true",
    "",
  ].join("\n");
}
