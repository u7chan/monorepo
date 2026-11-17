import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import { CheckIcon, TrashIcon } from "../icons";

/**
 * APIキーの入力。保存済みのキーは再表示しないため、欄は常に空から始める。
 * キーは画像・音声・BGM で共有し、画像の生成元が Codex でも音声 / BGM に要るので、
 * タブではなくページ共通の帯の下（変更を押したときだけ開く 1 行）に置く。
 */
export function ContentKeySection({
  keyStored,
  apiKey,
  busy,
  runtimeAvailable,
  providerName,
  onChange,
  onSubmit,
  onRemove,
}: {
  /** 保存済みかどうかだけを使う（値は画面へ戻さない） */
  keyStored: boolean;
  apiKey: string;
  busy: boolean;
  runtimeAvailable: boolean;
  providerName: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">APIキー</div>
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <input
            className="field min-w-0 flex-1 text-xs"
            type="password"
            value={apiKey}
            placeholder={keyStored ? "新しいコンテンツ生成のAPIキー（上書き）" : "コンテンツ生成のAPIキー"}
            aria-label="コンテンツ生成のAPIキー"
            autoComplete="off"
            spellCheck={false}
            disabled={!runtimeAvailable}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <button type="submit" className="btn-primary" disabled={!runtimeAvailable || busy || apiKey.length === 0}>
            <CheckIcon />
            {keyStored ? "上書き保存" : "保存"}
          </button>
        </form>
        {keyStored ? (
          <button
            type="button"
            className="btn-quiet"
            disabled={!runtimeAvailable || busy}
            onClick={() => void onRemove()}
          >
            <TrashIcon />
            削除
          </button>
        ) : null}
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">
        {providerName} のコンテンツ生成（画像 / 音声 /
        BGM）で共有するキーです。プロバイダータブで登録したキーとは別に管理し、 流用しません。キーは{" "}
        {API_KEY_MIN_LENGTH} 文字以上で入力します。
      </p>
    </section>
  );
}
