import { VOICE_INPUT_KEY_MIN_LENGTH } from "../../lib/voiceInputSettings";
import { StoredApiKeySection } from "../StoredApiKeySection";

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
    <StoredApiKeySection
      keyStored={keyStored}
      apiKey={apiKey}
      inputDisabled={!runtimeAvailable}
      saveDisabled={!canSave}
      removeDisabled={busy}
      placeholder={keyStored ? "新しい音声入力のAPIキー（上書き）" : "OpenAI Platform のAPIキー"}
      ariaLabel="音声入力のAPIキー"
      note={
        <>
          OpenAI Platform のAPIキーです（コンテンツ生成のキーとは別）。{VOICE_INPUT_KEY_MIN_LENGTH}{" "}
          文字以上で入力します。
        </>
      }
      onChange={onChange}
      onSubmit={onSubmit}
      onRemove={onRemove}
    />
  );
}
