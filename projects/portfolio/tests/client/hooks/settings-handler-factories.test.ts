import { describe, expect, it, vi } from 'vitest'
import {
  saveMirroredSetting,
  toggleBooleanSetting,
  type SettingUpdater,
} from '#/client/features/chat/components/chat-settings/hooks/settings-handler-factories'

const createUpdateSetting = () => vi.fn<SettingUpdater>()

describe('toggleBooleanSetting', () => {
  it('現在値を反転して、state と保存値の両方へ書く', () => {
    const updateSetting = createUpdateSetting()
    const setValue = vi.fn()

    toggleBooleanSetting(updateSetting, 'streamMode', true, setValue)

    expect(setValue).toHaveBeenCalledWith(false)
    expect(updateSetting).toHaveBeenCalledWith('streamMode', false)
  })

  it('オフからオンへ反転する', () => {
    const updateSetting = createUpdateSetting()
    const setValue = vi.fn()

    toggleBooleanSetting(updateSetting, 'markdownPreview', false, setValue)

    expect(setValue).toHaveBeenCalledWith(true)
    expect(updateSetting).toHaveBeenCalledWith('markdownPreview', true)
  })
})

describe('saveMirroredSetting', () => {
  it('入力値を変換せずそのまま保存する', () => {
    const updateSetting = createUpdateSetting()

    saveMirroredSetting(updateSetting, 'baseURL', 'https://example.test')

    expect(updateSetting).toHaveBeenCalledWith('baseURL', 'https://example.test')
  })

  it('未入力を undefined として保存する', () => {
    const updateSetting = createUpdateSetting()

    saveMirroredSetting(updateSetting, 'maxTokens', undefined)

    expect(updateSetting).toHaveBeenCalledWith('maxTokens', undefined)
  })
})
