import type { ReactNode } from "react";
import { CheckIcon, TrashIcon } from "./icons";

export type StoredApiKeySectionProps = {
  /** 保存済みかどうかだけを使う（値は画面へ戻さない） */
  keyStored: boolean;
  apiKey: string;
  /** 入力欄を止めるか。runtime の可否と保存中の扱いは画面ごとに違う */
  inputDisabled: boolean;
  saveDisabled: boolean;
  removeDisabled: boolean;
  placeholder: string;
  ariaLabel: string;
  /** 欄の下に出す説明。何のキーかは画面だけが知る */
  note: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onRemove: () => Promise<void>;
};

/**
 * 保存・上書き・削除を持つ秘密の入力欄。保存済みの値は再表示せず、入力欄は常に下書きから始める。
 * 何を止めるかは呼び出し側が決める（音声のキーは runtime が無くても削除できる）。
 */
export function StoredApiKeySection({
  keyStored,
  apiKey,
  inputDisabled,
  saveDisabled,
  removeDisabled,
  placeholder,
  ariaLabel,
  note,
  onChange,
  onSubmit,
  onRemove,
}: StoredApiKeySectionProps) {
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
            placeholder={placeholder}
            aria-label={ariaLabel}
            autoComplete="off"
            spellCheck={false}
            disabled={inputDisabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <button type="submit" className="btn-primary" disabled={saveDisabled}>
            <CheckIcon />
            {keyStored ? "上書き保存" : "保存"}
          </button>
        </form>
        {keyStored ? (
          <button type="button" className="btn-quiet" disabled={removeDisabled} onClick={() => void onRemove()}>
            <TrashIcon />
            削除
          </button>
        ) : null}
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">{note}</p>
    </section>
  );
}
