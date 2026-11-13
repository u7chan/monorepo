/**
 * 設定 → Git の identity の入力規則と文言。保存の正は server/src/git-identity.ts で、
 * ここは保存前に同じ理由を出して往復を減らすためだけに同じ規則を持つ。
 */

export const GIT_USER_NAME_MAX_LENGTH = 100;
export const GIT_USER_EMAIL_MAX_LENGTH = 254;

/** 制御文字・NUL・改行と `<` `>` は server と同じく受け付けない */
// oxlint-disable-next-line no-control-regex -- server と同じ規則で、INI と env を壊す値を意図的に検出する
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ANGLE_BRACKETS = /[<>]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 画面の既定の注記。反映の境界を送信前に伝える */
export const GIT_SETTINGS_NOTE =
  "Git の名前とメールアドレスは、エージェントの bash で commit するときに使われます。保存は次の bash から反映されます。";
export const GIT_SETTINGS_SAVED_NOTE = "保存しました。次の bash から反映されます。";
export const GIT_SETTINGS_CLEARED_NOTE = "未設定に戻しました。次の bash から反映されます。";
export const GIT_SETTINGS_LOAD_ERROR = "Git の設定を読み込めませんでした。";

/** 未設定のバッジと説明。プロンプトの案内だけに頼らず、画面でも気付けるようにする */
export const GIT_IDENTITY_UNSET_BADGE = "Git identity 未設定";
export const GIT_IDENTITY_SET_BADGE = "設定済み";
export const GIT_IDENTITY_UNSET_NOTE =
  "未設定のため、エージェントの commit は identity が無いと失敗します（repo local の設定があれば commit できます）。";

/** クリアの確認。保存値を消すだけで、サンドボックスの config は次の bash で書き換わる */
export const GIT_IDENTITY_CLEAR_CONFIRM = {
  kind: "confirm" as const,
  title: "Git identity を未設定に戻す",
  subject: { label: "この操作で消える設定", value: "Git の名前とメールアドレス" },
  body: ["次の bash から、identity の無い config（useConfigOnly）に切り替わります。"],
  confirmLabel: "未設定に戻す",
  danger: true,
};

/** 保存できない理由。空白だけの入力も server と同じく拒否する */
export function gitIdentityInputProblem(rawUserName: string, rawUserEmail: string): string | undefined {
  // 制御文字は前後の空白として落とさず、入力のまま拒否する (server/src/git-identity.ts と同じ)
  if (CONTROL_CHARACTERS.test(rawUserName) || CONTROL_CHARACTERS.test(rawUserEmail)) {
    return "Git の名前とメールアドレスに制御文字や改行は使えません";
  }
  if (ANGLE_BRACKETS.test(rawUserName) || ANGLE_BRACKETS.test(rawUserEmail)) {
    return "Git の名前とメールアドレスに < と > は使えません";
  }
  const name = rawUserName.trim();
  const email = rawUserEmail.trim();
  if (!name) return "Git の名前を入力してください";
  if (!email) return "Git のメールアドレスを入力してください";
  if (name.length > GIT_USER_NAME_MAX_LENGTH) {
    return `Git の名前は ${GIT_USER_NAME_MAX_LENGTH} 文字以内にしてください`;
  }
  if (email.length > GIT_USER_EMAIL_MAX_LENGTH) {
    return `Git のメールアドレスは ${GIT_USER_EMAIL_MAX_LENGTH} 文字以内にしてください`;
  }
  if (!EMAIL_SHAPE.test(email)) return "Git のメールアドレスの形式が正しくありません";
  return undefined;
}

/** 保存できるかの判定。dirty でないときはボタンを押させない (無変更の往復を作らない) */
export function gitIdentityCanSave(
  draft: { userName: string; userEmail: string },
  settings: { userName: string | null; userEmail: string | null },
  saving: boolean,
): boolean {
  if (saving) return false;
  if (gitIdentityInputProblem(draft.userName, draft.userEmail)) return false;
  return draft.userName.trim() !== (settings.userName ?? "") || draft.userEmail.trim() !== (settings.userEmail ?? "");
}
