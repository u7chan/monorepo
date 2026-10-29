import { useLayoutEffect, useRef } from "react";
import { useMessageCopy } from "../hooks/useMessageCopy";
import {
  splitWorkFolderPath,
  workFolderMenu,
  workFolderPathMinWidth,
  WORK_FOLDER_COPY_STATUS,
  type WorkFolderActionKind,
} from "../lib/sessionFilesPath";
import { PathCopyFailure } from "./file-tree/PathCopyFailure";
import { RowMenu } from "./RowMenu";

export type WorkFolderPathMenuProps = {
  /** 作業フォルダ (ワークスペース root 相対)。帯に出すパス */
  root: string;
  /** 作業フォルダの絶対パス。undefined = 絶対パスをコピーできない (理由を出す) */
  absolutePath?: string;
  /** 選択中セッションの ID (`envScope.sessionId`)。空 = 会話がまだ無い */
  sessionId?: string;
  /** プロジェクト所属なら末尾 1 段、未所属なら 2 段。undefined はプロジェクト相当 */
  projectSession?: boolean;
  /** 末尾と ⋯ に必要な幅。`TabToolbar` の context 最小幅として呼び出し側が使う */
  onRequiredWidth: (width: number) => void;
};

/**
 * 作業フォルダ面の帯のパス表示と ⋯。パスと ⋯ は 1 つの折り返さない組にして、組の幅 (省略前の
 * パス全体 + ⋯) を帯の文脈の最小幅へ渡す。収まらない幅では組ごと全幅の段へ落ちるので、短いパスを
 * 省略しない。`useMessageCopy` と結果表示もこの部品が所有し、呼び出し側が `sessionId` を key に
 * して remount する (同じ cwd の会話切替ではパネルが remount されないため)。
 */
export function WorkFolderPathMenu({
  root,
  absolutePath,
  sessionId,
  projectSession,
  onRequiredWidth,
}: WorkFolderPathMenuProps) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy(sessionId ?? "");
  const menu = workFolderMenu({ sessionId, absolutePath });
  const { prefix, tail } = splitWorkFolderPath(root, projectSession);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const prefixRef = useRef<HTMLSpanElement | null>(null);
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 組 (パス + ⋯) に必要な幅を測り、帯の段を分けるかの材料にする。truncate 中の scrollWidth は
  // 省略前の幅を返すので、表示が切れているかに関係なく省略前のパス全体を測れる
  useLayoutEffect(() => {
    const group = groupRef.current;
    const tailElement = tailRef.current;
    if (group === null || tailElement === null) return;
    const measure = () => {
      const path = (prefixRef.current?.scrollWidth ?? 0) + tailElement.scrollWidth;
      const menuWidth = menuRef.current?.offsetWidth ?? 0;
      const gap = menuWidth === 0 ? 0 : Number.parseFloat(getComputedStyle(group).columnGap) || 0;
      onRequiredWidth(workFolderPathMinWidth({ path, menu: menuWidth, gap }));
    };
    measure();
    // ResizeObserver の callback 内で同期に再レイアウトさせると loop 警告になるため rAF へずらす
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    for (const element of [prefixRef.current, tailElement, menuRef.current]) {
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [onRequiredWidth, root, projectSession, menu.menu]);

  const copy = (kind: WorkFolderActionKind) => {
    // 取れない値の項目は disabled で、理由が 2 行目に出ている。押されても別の値で代替しない
    if (kind === "copy-session-id") {
      if (sessionId !== undefined && sessionId !== "") void copyMessage(sessionId, kind);
      return;
    }
    if (absolutePath !== undefined) void copyMessage(absolutePath, kind);
  };
  const copiedKind =
    copiedId === "copy-session-id" || copiedId === "copy-absolute-path"
      ? (copiedId as WorkFolderActionKind)
      : undefined;
  const failure = copyFailure("copy-session-id") ?? copyFailure("copy-absolute-path");

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {/* パスと ⋯ は折り返さない 1 つの組にする。組の中で折り返すと、帯の幅が足りないときも
          パスが細い段に残って ⋯ だけが落ち、短いパスが省略される */}
      <div ref={groupRef} className="flex min-w-0 items-center gap-x-1.5">
        {/* 前置きだけを縮め、末尾 (未所属会話ではセッション ID) は幅を確保する。末尾自身が段の幅を超える
            長いプロジェクト名では max-w-full で末尾も truncate に落ちる */}
        <code title={root} className="flex min-w-0 items-center text-2xs leading-normal text-ink-muted">
          {prefix === "" ? null : (
            <span ref={prefixRef} className="min-w-0 truncate">
              {prefix}
            </span>
          )}
          <span ref={tailRef} className="max-w-full shrink-0 truncate">
            {tail}
          </span>
        </code>
        {menu.menu ? (
          <div ref={menuRef} className="flex shrink-0 items-center">
            <RowMenu
              name="作業フォルダのパス"
              actions={menu.actions}
              copied={copiedKind !== undefined}
              touchTarget="toolbar"
              onSelect={copy}
            />
          </div>
        ) : null}
      </div>
      {menu.menu ? null : (
        // 全項目 disabled のときは ⋯ を出さず、できない理由をパスの下へ常設する (キーボードでも読める)
        <span className="basis-full text-2xs leading-relaxed text-ink-ghost">
          {menu.reasons.map((reason) => (
            <span key={reason} className="block">
              {reason}
            </span>
          ))}
        </span>
      )}
      <span role="status" className="sr-only">
        {copiedKind === undefined ? "" : WORK_FOLDER_COPY_STATUS[copiedKind]}
      </span>
      <PathCopyFailure detail={failure} />
    </div>
  );
}
