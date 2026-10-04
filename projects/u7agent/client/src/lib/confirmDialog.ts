/**
 * 共通の確認ダイアログに渡す内容。DOM に依存しないので、文言とボタン名は各ドメインの lib で組み立てて
 * client test で固定する（ネイティブの `confirm` / `prompt` は DOM が無いと検証できない、という
 * `modelSettings.ts` と同じ理由）。見た目と開閉は `components/ConfirmDialog.tsx` が持つ。
 */

/** ダイアログの共通部分。対象名は本文へ埋めず `subject` の独立した行に出し、長い名前は 2 行で clamp する */
type DialogBase = {
  /** 見出し。読み上げ名 (`aria-label`) も兼ねる */
  title: string;
  /** 本文の段落 */
  body?: readonly string[];
  /** 操作の対象（会話タイトル・ファイルパス・名前など）。全文は `title` 属性で読める */
  subject?: { label: string; value: string };
  /** 取り消す側のボタン。既定は「キャンセル」 */
  cancelLabel?: string;
};

export type ConfirmRequest = DialogBase & {
  kind: "confirm";
  /** 等幅で独立した行に出す値（起動コマンドなど） */
  code?: { label: string; value: string };
  /** 本文の後に出す補足（実行中など、判断が変わる注意） */
  notes?: readonly string[];
  /** 実行する側のボタン。何をするかを書く（OK / はい に意味を載せない） */
  confirmLabel: string;
  /** 取り消せない操作・他者の状態を壊す操作を danger のトーンにする */
  danger?: boolean;
};

export type PromptRequest = DialogBase & {
  kind: "prompt";
  /** 入力欄のラベル（読み上げ名） */
  label: string;
  /** 現在の値。取り消しと同じく、空・未変更を何もしない扱いにするかは呼び出し側が決める */
  defaultValue: string;
  confirmLabel: string;
};

export type DialogRequest = ConfirmRequest | PromptRequest;

/**
 * リネームの入力の結果。取り消し (`null`)・空・未変更は undefined にして、サーバーへ送らない。
 * 設定 → ファイル のフォルダと、サイドバーのセッションで同じ規則を使う。
 */
export function renameInputValue(value: string | null, current: string): string | undefined {
  return value && value !== current ? value : undefined;
}
