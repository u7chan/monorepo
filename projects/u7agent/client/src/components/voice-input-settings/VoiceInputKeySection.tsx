import { VOICE_INPUT_KEY_MIN_LENGTH } from "../../lib/voiceInputSettings";
import { CheckIcon, TrashIcon } from "../icons";

/**
 * 音声入力の APIキーの入力。保存済みのキーは再表示しないため、欄は常に空から始める。
 * 削除は暗号化にもマスカーにも依存しないので、ランタイムやキーの状態に関係なく押せる。
 */
export function VoiceInputKeySection({
  keyStored,
  apiKey,
  busy,
  runtimeAvailable,
  canSave,
  onChange,
  onSubmit,
  onRemove,
}: {
  /** 保存済みかどうかだけを使う（値は画面へ戻さない） */
  keyStored: boolean;
  apiKey: string;
  busy: boolean;
  /** false の起動では登録・置換を 503 にする（削除はそのまま押せる） */
  runtimeAvailable: boolean;
  /** 入力の検証とランタイムの可否を親がまとめて決める（純関数は lib/voiceInputSettings.ts） */
  canSave: boolean;
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
            placeholder={keyStored ? "新しい音声入力のAPIキー（上書き）" : "OpenAI Platform のAPIキー"}
            aria-label="音声入力のAPIキー"
            autoComplete="off"
            spellCheck={false}
            disabled={!runtimeAvailable}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <button type="submit" className="btn-primary" disabled={!canSave}>
            <CheckIcon />
            {keyStored ? "上書き保存" : "保存"}
          </button>
        </form>
        {keyStored ? (
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void onRemove()}>
            <TrashIcon />
            削除
          </button>
        ) : null}
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">
        OpenAI Platform のAPIキーです（コンテンツ生成のキーとは別）。{VOICE_INPUT_KEY_MIN_LENGTH} 文字以上で入力します。
      </p>
    </section>
  );
}
