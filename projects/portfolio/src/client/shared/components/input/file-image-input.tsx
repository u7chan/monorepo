import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CloseIcon } from '#/client/shared/icons/close-icon'

interface Props {
  fileInputButton?: (onClick: () => void) => ReactNode
  onImageChange?: (src: string, index?: number) => void
}

export function FileImageInput({ fileInputButton, onImageChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0]
      const reader = new FileReader()
      reader.onloadend = () => {
        onImageChange?.(reader.result as string)
        e.target.value = ''
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div>
      <input ref={fileInputRef} type='file' accept='image/*' className='hidden' onChange={handleFileChange} />
      {fileInputButton?.(handleClick)}
    </div>
  )
}

interface FileImagePreviewProps {
  maxImages?: number
  src?: string | string[]
  contextLabel?: string
  children?: ReactNode
  onImageChange?: (src: string, index?: number) => void
}

export function FileImagePreview({ maxImages = 3, src, contextLabel, children, onImageChange }: FileImagePreviewProps) {
  const [showImageIndex, setShowImageIndex] = useState<number | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleHideImage()
      }
    }

    if (showImageIndex !== null) {
      window.addEventListener('keydown', handleKeyDown)
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [showImageIndex])

  const handleShowImage = (index: number) => {
    setShowImageIndex(index)
  }

  const handleHideImage = () => {
    setShowImageIndex(null)
  }

  const handleRemoveImage = (index: number) => {
    onImageChange?.('', index)
  }

  const showChildren = src ? (typeof src === 'string' ? !src : src.length < maxImages) : false

  return (
    <div className='flex items-center gap-2'>
      {showChildren && children}
      {src &&
        (typeof src === 'string' ? (
          <ImagePreview
            src={src}
            contextLabel={contextLabel}
            onImageClick={() => handleShowImage(0)}
            onCloseClick={() => handleRemoveImage(0)}
          />
        ) : (
          src.map((x, i) => (
            <ImagePreview
              key={i}
              src={x}
              contextLabel={contextLabel}
              onImageClick={() => handleShowImage(i)}
              onCloseClick={() => handleRemoveImage(i)}
            />
          ))
        ))}
      {src && showImageIndex !== null && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/75'>
          <div className='relative w-full max-w-3xl p-4'>
            <img
              src={typeof src === 'string' ? src : src[showImageIndex]}
              alt='preview'
              className='max-h-[80vh] w-full rounded object-contain shadow-lg'
            />
          </div>
          <button
            type='button'
            onClick={handleHideImage}
            className='absolute top-0 right-0 font-bold text-2xl text-white hover:text-gray-300'
          >
            <CloseIcon size={48} className='fill-white' />
          </button>
        </div>
      )}
    </div>
  )
}

interface ImagePreviewProps {
  src?: string
  contextLabel?: string
  onImageClick?: () => void
  onCloseClick?: () => void
}

function ImagePreview({ src, contextLabel, onImageClick, onCloseClick }: ImagePreviewProps) {
  return (
    <div className='relative h-12 w-12'>
      <img
        src={src}
        alt='thumbnail'
        className='pointer-events-none h-full w-full rounded-md border border-gray-300 bg-black object-contain'
      />
      <button
        type='button'
        onClick={onImageClick}
        className='absolute inset-0 h-full w-full cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-gray-400'
      />
      <button
        type='button'
        onClick={onCloseClick}
        className='absolute -top-2 left-9.5 flex cursor-pointer items-center justify-center rounded-full border bg-primary-800 hover:bg-primary-700'
      >
        <CloseIcon size={16} className='fill-white' />
      </button>
      {contextLabel && (
        <span className='absolute -bottom-2 left-1/2 max-w-24 -translate-x-1/2 whitespace-nowrap rounded-full border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300'>
          {contextLabel}
        </span>
      )}
    </div>
  )
}
