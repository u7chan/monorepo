import { useState } from 'react'
import type { GeneratedImage } from '#/types'

export interface ImageAsset {
  fileName: string
  publicPath: string
  previewUrl?: string
  contentType: string
  createdAt: string
}

interface ImageAssetPreviewProps {
  images: readonly ImageAsset[]
  label?: string
}

export function ImageAssetPreview({ images, label = 'Generated images' }: ImageAssetPreviewProps) {
  const [selectedImage, setSelectedImage] = useState<ImageAsset | null>(null)
  const visibleImages = images.filter((image): image is GeneratedImage => Boolean(image.previewUrl))

  if (visibleImages.length === 0) {
    return null
  }

  return (
    <div className='mt-2 flex flex-wrap gap-3' aria-label={label}>
      {visibleImages.map((image) => (
        <div key={image.publicPath} className='flex max-w-sm flex-col gap-1'>
          <button
            type='button'
            className='cursor-zoom-in overflow-hidden rounded-lg border border-gray-200 bg-gray-50 text-left dark:border-gray-700 dark:bg-gray-900'
            onClick={() => setSelectedImage(image)}
            aria-label={`画像を拡大表示: ${image.fileName}`}
          >
            <img src={image.previewUrl} alt={image.fileName} className='block max-h-80 max-w-full object-contain' />
          </button>
          <a
            href={image.previewUrl}
            download={image.fileName}
            className='self-start text-xs text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
          >
            画像をダウンロード
          </a>
        </div>
      ))}

      {selectedImage?.previewUrl && (
        <div
          role='dialog'
          aria-modal='true'
          aria-label={`画像を拡大表示: ${selectedImage.fileName}`}
          className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4'
          onClick={() => setSelectedImage(null)}
        >
          <div className='relative max-h-full max-w-full' onClick={(event) => event.stopPropagation()}>
            <img
              src={selectedImage.previewUrl}
              alt={selectedImage.fileName}
              className='max-h-[85vh] max-w-[90vw] object-contain'
            />
            <div className='mt-2 flex justify-end gap-2'>
              <a
                href={selectedImage.previewUrl}
                download={selectedImage.fileName}
                className='rounded-md bg-white px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100'
              >
                ダウンロード
              </a>
              <button
                type='button'
                onClick={() => setSelectedImage(null)}
                className='rounded-md bg-white px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100'
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
