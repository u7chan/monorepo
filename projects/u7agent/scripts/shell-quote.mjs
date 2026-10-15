/**
 * 埋め込む値を POSIX shell の単一引用符で囲む。単一引用符の中で `'` だけが特別なので、いったん閉じて
 * `'\''` で再開する (空白・`$`・バッククォート・`;` などは文字列として渡る)。
 */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
