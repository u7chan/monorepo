import { useState } from "react";
import { useSpace } from "../SpaceContext";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export function SpaceSettingsPage(props: SettingsPageProps) {
  const space = useSpace();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <SettingsPageLayout {...props} eyebrow="SPACES" title="スペース" caption="選択はこのタブだけに保存されます。">
      <div className="grid min-h-0 content-start gap-4 overflow-y-auto p-4">
        <p className="text-sm text-ink-soft">
          スペースは認証や安全な隔離ではありません。共通設定・ファイル・公開サービスは共有されます。追加スペースは会話専用です。
        </p>
        <section aria-label="スペース一覧" className="grid gap-2">
          {space.spaces.map((item) => (
            <button
              type="button"
              key={item.id}
              className="btn-quiet"
              aria-pressed={item.id === space.selected.id}
              onClick={() => {
                if (item.id === space.selected.id) return;
                props.onBack();
                space.select(item.id);
              }}
            >
              {item.name}
              {item.id === space.selected.id ? "（選択中）" : ""}
            </button>
          ))}
        </section>
        <form
          className="grid max-w-lg gap-2"
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
          <label className="grid gap-1 text-sm">
            スペースの名前
            <input
              className="field"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <button className="btn-quiet" type="submit" disabled={busy || !name.trim()}>
            スペースを作成
          </button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
        <p className="text-sm text-ink-soft">
          作成したスペースを選ぶと空の会話一覧から始められます。会話は切り替えても残ります。削除・リセットはありません。
        </p>
      </div>
    </SettingsPageLayout>
  );
}
