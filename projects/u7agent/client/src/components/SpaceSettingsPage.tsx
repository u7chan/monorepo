import { useState } from "react";
import type { Space } from "server";
import { useSpace } from "../SpaceContext";
import { cn } from "../lib/cn";
import { spaceDeleteConfirmRequest, spaceRowActions } from "../lib/spaceSettings";
import { DEFAULT_SPACE_ID } from "../lib/spaceSelection";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { useConfirm } from "./ConfirmProvider";
import { MenuItem } from "./MenuItem";
import { RowMenu } from "./RowMenu";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { PlusIcon } from "./icons";

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
            <div className="grid min-w-0 gap-1">
              {space.spaces.map((item) => {
                const actions = spaceRowActions(item.id === DEFAULT_SPACE_ID);
                return (
                  // 行の選択 (主要な操作) と ⋯ は兄弟にする。入れ子にすると ⋯ の押下が選択を兼ねてしまう
                  <div key={item.id} className="flex min-w-0 items-center gap-1">
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
