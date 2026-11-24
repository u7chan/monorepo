/** 字句比較だけを行う。正規化や symlink の解決を代用しない。 */
export function isInsideRoot(root: string, target: string, sep: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** サンドボックスのワイヤ形式では OS によらず区切りが `/`。 */
export function fileExtension(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}
