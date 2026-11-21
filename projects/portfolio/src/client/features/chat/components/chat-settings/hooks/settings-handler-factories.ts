import type { Settings } from '#/client/shared/storage/remote-storage-settings'

export type SettingUpdater = <K extends keyof Settings>(key: K, value: Settings[K]) => Settings

type ToggleSettingKey =
  | 'temperatureEnabled'
  | 'autoModel'
  | 'markdownPreview'
  | 'streamMode'
  | 'includeChatHistory'
  | 'sendImagesOnlyOnce'
  | 'reasoningEffortEnabled'

type MirroredSettingKey =
  | 'baseURL'
  | 'apiKey'
  | 'maxTokens'
  | 'imageGenerationModel'
  | 'imageGenerationBaseURL'
  | 'imageGenerationApiKey'

/**
 * 真偽設定は「反転して保存」で揃っているので 1 箇所に寄せる。
 * fakeMode と apiMode は相互に効く規則を持つため呼び出し側に残す。
 */
export function toggleBooleanSetting(
  updateSetting: SettingUpdater,
  key: ToggleSettingKey,
  current: boolean,
  setValue: (value: boolean) => void
): void {
  const nextValue = !current
  setValue(nextValue)
  updateSetting(key, nextValue)
}

/**
 * 入力をそのまま保存するだけの設定。変換や連動更新が要るものは呼び出し側に残す。
 */
export function saveMirroredSetting<K extends MirroredSettingKey>(
  updateSetting: SettingUpdater,
  key: K,
  value: Settings[K]
): void {
  updateSetting(key, value)
}
