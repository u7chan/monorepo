import { useRef, useState } from "react";
import type { Space } from "server";
import { useSpace } from "../SpaceContext";
import { useAgentDrag, type AgentDragNaming } from "../hooks/useAgentDrag";
import { reorderRows } from "../lib/agentReorder";
import { cn } from "../lib/cn";
import { createSpaceOrderFlow, type SpaceOrderNoteKind, type SpaceOrderState } from "../lib/spaceOrder";
import { spaceDeleteConfirmRequest, spaceRowActions } from "../lib/spaceSettings";
import { DEFAULT_SPACE_ID } from "../lib/spaceSelection";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { useConfirm } from "./ConfirmProvider";
import { MenuItem } from "./MenuItem";
import { RowMenu } from "./RowMenu";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { GripIcon, PlusIcon } from "./icons";

/** 一覧ごとに変える名前。styles/index.css の `.space-drag-row` / `body.is-dragging-space` と揃える */
const SPACE_DRAG_NAMING: AgentDragNaming = {
  rowAttribute: "data-space-row",
  yVariable: "--space-drag-y",
  bodyClass: "is-dragging-space",
};

/** 並べ替えの失敗の文言。保存されたかどうかで伝えることを分ける（client/src/lib/spaceOrder.ts） */
function orderNoteText(kind: SpaceOrderNoteKind, message: string): string {
  if (kind === "rejected") return `並び順を保存できませんでした。${message}`;
  return `並び順を保存できたか確認できません。再読み込みするとサーバーの並びに合わせます。（${message}）`;
}

/** 設定 → 会話スペース。作成フォームは一覧の上に置く (エージェント / スキルの追加行と同じ順で、一覧が伸びても作成操作が残る) */
export function SpaceSettingsPage({
  singleColumn = false,
  onBack,
  onOpenNav,
  onSelectSpace,
}: SettingsPageProps & {
  /** 行の選択。切替は App ごと作り直すため、URL の会話を切り離してから選ぶ (親が会話なしの chat へ戻す) */
  onSelectSpace?: () => void;
}) {
  const space = useSpace();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  /** 削除中の行 (空文字は不在)。二重の確認を出さないための抑止で、行は生かしたままにする */
  const [deleting, setDeleting] = useState("");
  const [order, setOrder] = useState<SpaceOrderState>({ draft: null, saving: false });
  const [orderNote, setOrderNote] = useState("");
  // 並べ替えの下書きと保存。ドラッグの計算は lib/agentReorder、保存の手順は lib/spaceOrder が持ち、
  // ここは state への反映と文言だけを持つ。確定順の一覧は SpacesApp が持つ (同じ一覧を作成・削除が差分更新する)
  const orderDeps = useRef({ spaces: space.spaces, reorder: space.reorder, applyOrder: space.applyOrder });
  orderDeps.current = { spaces: space.spaces, reorder: space.reorder, applyOrder: space.applyOrder };
  const [orderFlow] = useState(() =>
    createSpaceOrderFlow({
      ids: () => orderDeps.current.spaces.filter((item) => item.id !== DEFAULT_SPACE_ID).map((item) => item.id),
      save: (ids) => orderDeps.current.reorder(ids),
      apply: (ids) => orderDeps.current.applyOrder(ids),
      note: (kind, message) => setOrderNote(orderNoteText(kind, message)),
      onChange: setOrder,
    }),
  );
  // ドラッグ中は下書きの順で並べる。既定スペースは先頭固定で、並べ替えの対象にしない。
  // ドラッグ中に一覧が変わっても下書きは id の並びなので壊れない: 下書きに無い行（作成中の行）は
  // その場に残り、消えた行の id は並べる相手が無いだけで無視される (`reorderRows`)
  const visibleSpaces = order.draft ? reorderRows(space.spaces, order.draft) : space.spaces;
  const reorderIds = visibleSpaces.filter((item) => item.id !== DEFAULT_SPACE_ID).map((item) => item.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useAgentDrag({
    containerRef,
    naming: SPACE_DRAG_NAMING,
    ids: reorderIds,
    onMove: (ids) => orderFlow.preview(ids),
    onCommit: () => void orderFlow.commit(),
    onCancel: () => orderFlow.cancel(),
    disabled: order.saving,
  });

  const requestDelete = async (item: Space) => {
    if (deleting) return;
    if (!(await confirm(spaceDeleteConfirmRequest(item)))) return;
    setDeleting(item.id);
    setDeleteError("");
    try {
      // 選択中のスペースを消したら、App の作り直しに任せず会話を持たない chat へ移る。作り直しは
      // 現在の URL (設定ページ) を読むため、移らないと削除後の F5 でも設定に戻ってしまう
      await space.remove(item.id, () => onSelectSpace?.());
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "スペースを削除できませんでした。");
    } finally {
      setDeleting("");
    }
  };

  return (
    <SettingsPageLayout
      eyebrow="SPACES"
      title="会話スペース"
      caption="選択はこのブラウザーに保存されます。"
      singleColumn={singleColumn}
      onBack={onBack}
      onOpenNav={onOpenNav}
      note={orderNote ? { text: orderNote, error: true } : undefined}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl content-start gap-3">
          <CollapsibleNotice summary="認証や安全な隔離ではありません。共通設定・ファイル・公開サービスは共有されます。">
            <p>追加の会話スペースは会話専用です。</p>
          </CollapsibleNotice>
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">新しい会話スペース</h3>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !name.trim()) return;
                setBusy(true);
                setError("");
                void space
                  .create(name.trim())
                  .then(
                    () => setName(""),
                    (error: unknown) => setError(error instanceof Error ? error.message : "作成できませんでした。"),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <input
                className={cn("field min-w-0 flex-1", singleColumn ? "text-md" : "text-xs")}
                maxLength={80}
                value={name}
                aria-label="会話スペースの名前"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
                <PlusIcon />
                作成
              </button>
            </form>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </section>
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
              会話スペース一覧
              <span className="font-normal">{space.spaces.length}</span>
            </h3>
            {/* 高さの上限は持たない。作成フォームが上にあるため、一覧が伸びても作成操作は画面外へ出ない */}
            <div ref={containerRef} className="grid min-w-0 gap-1" {...drag.containerHandlers}>
              {visibleSpaces.map((item) => {
                const actions = spaceRowActions(item.id === DEFAULT_SPACE_ID);
                const reorderable = item.id !== DEFAULT_SPACE_ID;
                return (
                  // 行の選択 (主要な操作)・グリップ・⋯ は兄弟にする。入れ子にすると押下が選択を兼ねてしまう
                  <div
                    key={item.id}
                    data-space-row={item.id}
                    className={cn("flex min-w-0 items-center gap-1", drag.draggingId === item.id && "space-drag-row")}
                  >
                    {reorderable ? (
                      // グリップは ⋯ と反対側に置く (⋯ は削除なので、狙った指がドラッグを始めない)
                      <button
                        type="button"
                        aria-label={`${item.name}の順番を変更`}
                        className="drag-grip"
                        {...drag.gripHandlers(item.id)}
                      >
                        <GripIcon />
                      </button>
                    ) : null}
                    <MenuItem
                      label={item.name}
                      variant="choice"
                      selected={item.id === space.selected.id}
                      current="true"
                      onClick={() => {
                        if (item.id === space.selected.id) return;
                        onSelectSpace?.();
                        space.select(item.id);
                      }}
                    />
                    {actions.length > 0 ? (
                      <RowMenu name={item.name} actions={actions} onSelect={() => void requestDelete(item)} />
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="text-2xs leading-relaxed text-ink-ghost">
              作成した会話スペースを選ぶと空の会話一覧から始められます。会話は切り替えても残ります。追加スペースは行の ⋯
              から削除できます（既定スペースは削除できません）。
            </p>
            {deleteError ? (
              <p role="alert" className="text-sm text-danger">
                {deleteError}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </SettingsPageLayout>
  );
}
