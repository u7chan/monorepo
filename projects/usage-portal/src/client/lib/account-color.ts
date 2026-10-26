/**
 * アイコンの背景色。白い絵文字を載せるので、どの色でもコントラスト 4.5:1 以上になる濃さに固定する。
 * 色数は 8。12 種のアイコンと組み合わせて、同じアイコンのアカウントが並んでも見分けられるようにする。
 */
export const ACCOUNT_ICON_COLORS = [
  "#9a3412",
  "#9f1239",
  "#6b21a8",
  "#1e40af",
  "#155e75",
  "#166534",
  "#3f6212",
  "#7c2d12",
] as const;

/**
 * id から背景色を決める。サーバーに色を持たせず、並び替えても同じアカウントが同じ色になるようにする。
 * FNV-1a は短い id でも偏りが小さく、実装が 5 行で済む。
 */
export function accountIconColor(id: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return ACCOUNT_ICON_COLORS[hash % ACCOUNT_ICON_COLORS.length] as string;
}
