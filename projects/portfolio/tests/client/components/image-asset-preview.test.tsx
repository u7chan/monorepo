// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImageAssetPreview } from '#/client/features/chat/components/image-asset-preview'

describe('画像アセットプレビュー', () => {
  it('画像を再読込表示し、拡大表示と download link を提供する', () => {
    render(
      <ImageAssetPreview
        images={[
          {
            fileName: 'assistant-image-0.png',
            publicPath: '/public/portfolio/conversation/assistant-image-0.png',
            previewUrl: 'https://files.example.test/public/portfolio/conversation/assistant-image-0.png',
            contentType: 'image/png',
            createdAt: '2026-08-10T00:00:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '画像をダウンロード' }).getAttribute('href')).toBe(
      'https://files.example.test/public/portfolio/conversation/assistant-image-0.png'
    )

    fireEvent.click(screen.getByRole('button', { name: '画像を拡大表示: assistant-image-0.png' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
