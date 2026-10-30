import { useFileIconStyleSetting } from "../../hooks/useFileIconStyle";
import { cn } from "../../lib/cn";
import { FILE_ICON_STYLES, type FileIconStyle } from "../../lib/fileIconStyle";
import type { FileKind } from "../../lib/fileKind";
import { CheckIcon, FileIcon, FolderIcon } from "../icons";

/** プレビューの行。フォルダ 1 つと、色の出る種類を 3 つだけ見せる */
const PREVIEW_ROWS: { name: string; dir?: boolean; kind?: FileKind }[] = [
  { name: "src", dir: true },
  { name: "FileBrowser.tsx", kind: "code" },
  { name: "index.css", kind: "style" },
  { name: "package.json", kind: "data" },
];

/**
 * 見た目の縮小プレビュー。本物のツリー (FileBrowser) は root が要るので、行の形だけを写した静的な並びに
 * する。色の切り替えは data-file-icons を付けたこの要素の配下だけで効く (styles/index.css)。
 */
function FileIconStylePreview({ value }: { value: FileIconStyle }) {
  return (
    <div data-file-icons={value} aria-hidden className="grid gap-0.5 rounded-md bg-base px-2 py-1.5">
      {PREVIEW_ROWS.map((row) => (
        <span
          key={row.name}
          className={cn("flex min-w-0 items-center gap-2 text-2xs text-ink-muted", row.dir ? "" : "pl-4")}
        >
          {row.dir ? <FolderIcon /> : <FileIcon kind={row.kind} />}
          <span className="truncate">{row.name}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 設定 → 外観 → アイコン。ファイルツリーの行の見た目を選ぶ。並びは既定 (線) が先頭で、
 * 設定画面では「推奨」のようなバッジを出さない (既定を勝手に動かさないため、選ぶのは利用者)。
 */
export function FileIconStyleSettings() {
  const { style, setStyle } = useFileIconStyleSetting();

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">ファイルツリーのアイコン</div>
      <div role="radiogroup" aria-label="ファイルツリーのアイコン" className="grid gap-2 wide:grid-cols-3">
        {FILE_ICON_STYLES.map((item) => {
          const selected = style === item.id;
          return (
            <label
              key={item.id}
              className={cn(
                "grid cursor-pointer gap-2 rounded-lg border bg-panel p-2 transition-colors focus-within:ring-2 focus-within:ring-focus",
                selected ? "border-focus" : "border-line hover:border-accent/50",
              )}
            >
              <input
                type="radio"
                name="file-icon-style"
                value={item.id}
                checked={selected}
                onChange={() => setStyle(item.id)}
                className="sr-only"
              />
              <FileIconStylePreview value={item.id} />
              <span className="flex items-center gap-1.5 px-0.5">
                <span className={cn("text-xs font-semibold", selected ? "text-accent-text" : "text-ink")}>
                  {item.label}
                </span>
                {selected ? (
                  <span className="ml-auto text-accent-text">
                    <CheckIcon />
                  </span>
                ) : null}
              </span>
              <span className="px-0.5 text-2xs leading-relaxed text-ink-ghost">{item.description}</span>
            </label>
          );
        })}
      </div>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        既定は「線」です。未保存のときはこの見た目になります。設定はこのブラウザーに保存され、ファイルツリーが出る面すべて（設定
        → ファイル / チャットの右パネル / チャットのスキル面 / 設定 → スキルのファイルタブ）に効きます。
      </p>
    </section>
  );
}
