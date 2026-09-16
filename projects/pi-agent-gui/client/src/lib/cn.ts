/** className の連結。oxfmt の Tailwind class sorting は `sortTailwindcss.functions` に登録した関数の
 * 引数（条件分岐の中の文字列も含む）を並べ替えるため、実行時に組み立てる className はここを通す。 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
