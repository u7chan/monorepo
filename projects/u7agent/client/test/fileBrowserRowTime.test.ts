// ディレクトリ行 / ファイル行の時刻と右端のスロットを突き合わせる。client に DOM テスト基盤が無いため、
// 右 padding と末尾スロットによる px の一致は自動固定できず、手動確認に残す (docs/file-preview.md#時刻)。
// ここでは両行が同じ形であること（配線）だけを固定する。どれかが崩れると次のどれかになる。
//   1. ディレクトリ行の button が時刻を包み、読み上げ名に時刻が混ざる / 時刻のクリックで開閉する
//   2. 右 padding か末尾スロットの幅が変わり、ディレクトリ行とファイル行の時刻の右端がずれる
//   3. 時刻の表示規則 (messageTimeLabel + title の完全な表記) か、mtime 無しの行の扱いが変わる
//   4. ディレクトリ行の削除導線が消える / ファイル行と別の見た目になる
//   5. readOnly の行 (スキルのファイルタブ) に削除 / リネームが残る、または既存 2 画面が readOnly になる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/**
 * EntryRow のディレクトリ行 (分岐の先頭) / ファイル行 / 右端の共通部 (EntryRowActions) を切り出す。
 * 共通部は両行の外に置くため、行の断片に定義が混ざらないよう行ごとに切る。
 */
function entryRowSections(): { dir: string; file: string; actions: string; button: string } {
  const source = read("src/components/FileBrowser.tsx");
  const dirStart = source.indexOf('if (entry.type === "dir")');
  const fileStart = source.indexOf("const isSelected = selected === path;");
  const actionsStart = source.indexOf("export function EntryRowActions");
  const buttonStart = source.indexOf("/** 行のリネームボタン");
  const end = source.indexOf("function MessageRow");
  assert.ok(
    dirStart >= 0 &&
      fileStart > dirStart &&
      actionsStart > fileStart &&
      buttonStart > actionsStart &&
      end > buttonStart,
    "FileBrowser.tsx からディレクトリ行 / ファイル行 / 右端の共通部を切り出せない",
  );
  return {
    dir: source.slice(dirStart, fileStart),
    file: source.slice(fileStart, actionsStart),
    actions: source.slice(actionsStart, buttonStart),
    button: source.slice(buttonStart, end),
  };
}

test("ディレクトリ行とファイル行は同じ形の時刻と末尾スロットを持つ", () => {
  const { dir, file } = entryRowSections();
  for (const [label, row] of [
    ["ディレクトリ", dir],
    ["ファイル", file],
  ] as const) {
    assert.match(row, /<EntryTime\s+at=\{entry\.mtime\}/, `${label}行が行の時刻を出していない`);
    assert.ok(row.includes("pr-1"), `${label}行の右 padding が pr-1 でない`);
    assert.ok(!row.includes("pr-2"), `${label}行に pr-2 が残っている`);
    // 行の末尾は時刻 → 右端のスロット (リネーム / ゴミ箱 / symlink 用の空スペーサー)
    assert.ok(row.includes("<EntryRowActions"), `${label}行に右端のスロットが無い`);
    assert.ok(
      row.indexOf("<EntryTime") < row.indexOf("<EntryRowActions"),
      `${label}行の時刻が末尾スロットより後ろにある`,
    );
    // 削除の導線は通常ファイルとディレクトリの行に出す (symlink は共通部が EmptySlot へ落とす)
    assert.ok(
      row.includes("onDelete={() => onDelete(path, entry.type)}"),
      `${label}行の削除が種類ごとの入口へ渡っていない`,
    );
  }
});

test("ディレクトリ行の時刻は開閉の button の外に出す", () => {
  const { dir } = entryRowSections();
  const buttonEnd = dir.indexOf("</button>");
  assert.ok(buttonEnd >= 0, "ディレクトリ行に開閉の button が無い");
  // button の中に入れると accessible name に時刻が混ざり、時刻のクリックでも開閉してしまう
  assert.ok(dir.indexOf("<EntryTime") > buttonEnd, "時刻が開閉の button の中にある");
  assert.ok(dir.indexOf("<EntryTime") < dir.indexOf("<EntryRowActions"), "右端のスロットが時刻より前にある");
  assert.match(dir, /<button[^>]*\saria-expanded=\{open\}/, "開閉の button が aria-expanded を持たない");
  assert.ok(
    dir.includes('className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"'),
    "開閉の button が flex-1 でなく、クリック領域が行から狭まる",
  );
});

test("ディレクトリ行の削除は symlink には出さず、通常ファイル行と同じ条件で出す", () => {
  const { actions } = entryRowSections();
  // リネームはフォルダ行だけ、削除は symlink 以外 (ファイル / ディレクトリとも) に出し、残りは空スペーサーへ落とす
  assert.match(actions, /const renamable = canRename && type === "dir" && !symlink;/, "リネームの条件が変わった");
  assert.match(actions, /const deletable = !symlink;/, "削除の条件が変わった");
  assert.ok(actions.includes("{canRename ?"), "リネームのスロットが canRename で分岐していない");
  assert.ok(actions.includes("{deletable ?"), "削除のスロットが deletable で分岐していない");
});

test("読み取り専用の面では削除とリネームの導線ごと消す", () => {
  const { dir, file, actions } = entryRowSections();
  for (const [label, row] of [
    ["ディレクトリ", dir],
    ["ファイル", file],
  ] as const) {
    assert.ok(row.includes("readOnly={readOnly}"), `${label}行が readOnly を渡していない`);
  }
  // 条件で分岐を残すと空スペーサーだけが出る。行の操作ごと落とす
  assert.match(actions, /if \(readOnly\) return null;/, "readOnly で行の操作を消していない");
  // 既存 2 画面 (設定 → ファイル / チャット右パネル) は readOnly を渡さない (既定 false のまま)
  for (const screen of ["src/components/FileTreePage.tsx", "src/components/SessionFilesPanel.tsx"]) {
    assert.ok(!read(screen).includes("readOnly"), `${screen} が readOnly を渡している`);
  }
});

test("末尾スロットはリネーム / ゴミ箱 / 空スペーサーで同じ 24px 幅", () => {
  const { button } = entryRowSections();
  assert.match(button, /className="grid size-6 shrink-0 place-items-center/, "右端のボタンが size-6 でない");
  assert.match(button, /aria-label=\{`\$\{name\} の名前を変更`\}/, "リネームボタンに読み上げ名が無い");
  assert.match(button, /title="名前を変更"/, "リネームボタンに title が無い");
  assert.match(button, /aria-label=\{`\$\{name\} を削除`\}/, "削除ボタンに読み上げ名が無い");
  assert.match(button, /title="削除"/, "削除ボタンに title が無い");
  const source = read("src/components/FileBrowser.tsx");
  const start = source.indexOf("function EmptySlot");
  const end = source.indexOf("function EntryTime");
  assert.ok(start >= 0 && end > start, "EmptySlot を切り出せない");
  const emptySlot = source.slice(start, end);
  assert.match(emptySlot, /className="size-6 shrink-0"/, "空スペーサーがボタンと同じ size-6 でない");
  assert.match(emptySlot, /aria-hidden/, "空スペーサーが読み上げの対象になる");
});

test("削除のハンドラは種類ごとにサンドボックスの入口と confirm を分ける", () => {
  const source = read("src/components/FileBrowser.tsx");
  // 確認文言はディレクトリだけ配下ごと消えることを示す
  assert.ok(
    source.includes('type === "dir" ? fileTreeDeleteDirectoryConfirm(path) : fileTreeDeleteConfirm(path)'),
    "確認文言を種類で分けていない",
  );
  // API はディレクトリだけ deleteDirectory (recursive=true) へ委譲する
  assert.ok(source.includes("await deleteDirectory(fetchPath);"), "ディレクトリ削除を呼んでいない");
  assert.ok(source.includes("await deleteFile(fetchPath);"), "ファイル削除を呼んでいない");
  assert.ok(
    source.includes("closeFileTabsUnder(prev, path)") &&
      source.includes("removeFileTreeEntry(pruneFileTreeSubtree(prev, path), path)"),
    "削除したディレクトリ配下のタブ / 状態を落としていない",
  );
  assert.ok(source.includes("closeTab(path);"), "ファイル行のタブを閉じていない");
});

test("時刻は messageTimeLabel を表示し、title に完全な表記を出す", () => {
  const source = read("src/components/FileBrowser.tsx");
  const start = source.indexOf("function EntryTime");
  const end = source.indexOf("function MessageRow");
  assert.ok(start >= 0 && end > start, "EntryTime を切り出せない");
  const label = source.slice(start, end);
  assert.match(label, /dateTime=\{new Date\(at\)\.toISOString\(\)\}/, "dateTime を持たない");
  assert.match(label, /title=\{messageFullTimeLabel\(at\)\}/, "title に完全な表記を出していない");
  assert.match(label, /\{messageTimeLabel\(at\)\}/, "表示が messageTimeLabel でない");
  assert.match(label, /tabular-nums/, "tabular-nums が無く、数字の幅で行がガタつく");
  assert.ok(label.includes("if (at === undefined) return null;"), "mtime を持たない行にも時刻を出そうとしている");
});
