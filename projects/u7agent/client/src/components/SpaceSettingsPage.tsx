import { useState } from "react";
import { useSpace } from "../SpaceContext";
import { cn } from "../lib/cn";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { MenuItem } from "./MenuItem";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { PlusIcon } from "./icons";

/** 設定 → スペース。一覧は件数が増えても高さを抑え、作成フォームを画面内に残す */
export function SpaceSettingsPage({
  compact = false,
  onBack,
  onOpenNav,
  onSelectSpace,
}: SettingsPageProps & {
  /** 行の選択。切替は App ごと作り直すため、URL の会話を切り離してから選ぶ (親が会話なしの chat へ戻す) */
  onSelectSpace?: () => void;
}) {
  const space = useSpace();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <SettingsPageLayout
      eyebrow="SPACES"
      title="スペース"
      caption="選択はこのブラウザーに保存されます。"
      compact={compact}
      onBack={onBack}
      onOpenNav={onOpenNav}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl content-start gap-3">
          <CollapsibleNotice summary="認証や安全な隔離ではありません。共通設定・ファイル・公開サービスは共有されます。">
            <p>追加スペースは会話専用です。</p>
          </CollapsibleNotice>
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
              スペース一覧
              <span className="font-normal">{space.spaces.length}</span>
            </h3>
            {/* 上限が無いと件数分だけ伸び、作成フォームが画面外へ押し出される */}
            <div className="grid max-h-72 min-w-0 scrollbar-thin gap-1 overflow-x-hidden overflow-y-auto">
              {space.spaces.map((item) => (
                <MenuItem
                  key={item.id}
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
              ))}
            </div>
            <p className="text-2xs leading-relaxed text-ink-ghost">
              作成したスペースを選ぶと空の会話一覧から始められます。会話は切り替えても残ります。削除・リセットはありません。
            </p>
          </section>
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">新しいスペース</h3>
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
                className={cn("field min-w-0 flex-1", compact ? "text-md" : "text-xs")}
                maxLength={80}
                value={name}
                aria-label="スペースの名前"
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
        </div>
      </div>
    </SettingsPageLayout>
  );
}
