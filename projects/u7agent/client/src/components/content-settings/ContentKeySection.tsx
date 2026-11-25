import { API_KEY_MIN_LENGTH } from "../../lib/modelSettings";
import { StoredApiKeySection } from "../StoredApiKeySection";

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
    <StoredApiKeySection
      keyStored={keyStored}
      apiKey={apiKey}
      inputDisabled={!runtimeAvailable}
      saveDisabled={!runtimeAvailable || busy || apiKey.length === 0}
      removeDisabled={!runtimeAvailable || busy}
      placeholder={keyStored ? "新しいコンテンツ生成のAPIキー（上書き）" : "コンテンツ生成のAPIキー"}
      ariaLabel="コンテンツ生成のAPIキー"
      note={
        <>
          {providerName} のコンテンツ生成（画像 / 音声 /
          BGM）で共有するキーです。プロバイダータブで登録したキーとは別に管理し、 流用しません。キーは{" "}
          {API_KEY_MIN_LENGTH} 文字以上で入力します。
        </>
      }
      onChange={onChange}
      onSubmit={onSubmit}
      onRemove={onRemove}
    />
  );
}
