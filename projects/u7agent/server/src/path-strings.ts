export function isInsideRoot(root: string, target: string, sep: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** パスの拡張子を小文字で取る。拡張子なしと dotfile は undefined。 */
export function fileExtension(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}
