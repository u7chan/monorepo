/**
 * 並べ替えの保存に失敗したときの文言 (設定 → エージェント / 定型プロンプト / 会話スペース)。
 * 保存できたかで伝えることを分け、保存はできて取り直せなかった場合 (`"refresh"`) はページが持つ。
 */
export function orderFailureNoteText(kind: "rejected" | "unknown", message: string): string {
  if (kind === "rejected") return `並び順を保存できませんでした。${message}`;
  return `並び順を保存できたか確認できません。再読み込みするとサーバーの並びに合わせます。（${message}）`;
}
