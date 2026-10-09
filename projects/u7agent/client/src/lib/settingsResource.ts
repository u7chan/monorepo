/**
 * 設定資源の hook（`useSettingsResource`）と、同じ骨格を使う hook の文言。DOM に依存しない純関数だけを置く。
 */
import { ApiError } from "../api";

/** 例外から画面に出す 1 行。Error 以外が投げられても文を空にしない */
export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 変更系の失敗の注記。何も保存されなかった (503 not_stored / 400) ことを文言で区別する */
export function mutationErrorNote(error: unknown): string {
  const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
  return `${prefix}${messageFor(error)}`;
}

/** 成功注記の 2 形態。固定文言と、適用した応答から作る文言（provider 名など）を 1 箇所で解決する */
export type SettingsSuccessNote<TResponse> = string | ((response: TResponse) => string);

export function successNoteText<TResponse>(note: SettingsSuccessNote<TResponse>, response: TResponse): string {
  return typeof note === "function" ? note(response) : note;
}
