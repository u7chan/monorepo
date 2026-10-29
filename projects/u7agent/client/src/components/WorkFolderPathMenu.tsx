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
 * 作業フォルダ面の帯のパス表示と ⋯。`useMessageCopy` と結果表示をこの部品が所有し、呼び出し側が
 * `envScope.sessionId` を key にして remount する (同一 cwd の会話切替ではパネルが remount されないため、
 * 未完了のコピーの結果を前の会話へ出さない)。
 */
export function WorkFolderPathMenu({
  root,
  absolutePath,
  sessionId,
  projectSession,
  onRequiredWidth,
}: WorkFolderPathMenuProps) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const menu = workFolderMenu({ sessionId, absolutePath });
  const { prefix, tail } = splitWorkFolderPath(root, projectSession);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 末尾 (shrink-0) を縮めずに済む幅を測り、帯の段を分けるかの材料にする。truncate 中の scrollWidth は
  // 省略前の幅を返すので、表示が切れているかに関係なく同じ値を報告できる
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const tailElement = tailRef.current;
    if (wrapper === null || tailElement === null) return;
    const measure = () => {
      const gap = menu.menu ? Number.parseFloat(getComputedStyle(wrapper).columnGap) || 0 : 0;
      onRequiredWidth(
        workFolderPathMinWidth({ tail: tailElement.scrollWidth, menu: menuRef.current?.offsetWidth ?? 0, gap }),
      );
    };
    measure();
    // ResizeObserver の callback 内で同期に再レイアウトさせると loop 警告になるため rAF へずらす
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    observer.observe(tailElement);
    if (menuRef.current !== null) observer.observe(menuRef.current);
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
    <div ref={wrapperRef} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {/* 前置きだけを縮め、末尾 (未所属会話ではセッション ID) は幅を確保する。末尾自身が段の幅を超える
          長いプロジェクト名では max-w-full で末尾も truncate に落ちる */}
      <code title={root} className="flex min-w-0 items-center text-2xs leading-normal text-ink-muted">
        {prefix === "" ? null : <span className="min-w-0 truncate">{prefix}</span>}
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
      ) : (
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
