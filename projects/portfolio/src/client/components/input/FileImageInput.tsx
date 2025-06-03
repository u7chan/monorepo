import { type ReactNode, useRef, useState, useEffect } from 'react'

import { CloseIcon } from '@/client/components/svg/CloseIcon'

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
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type='file'
        accept='image/*'
        className='hidden'
        onChange={handleFileChange}
      />
      {fileInputButton?.(handleClick)}
    </div>
  )
}

interface FileImagePreviewProps {
  maxImages?: number
  src?: string | string[]
  children?: ReactNode
  onImageChange?: (src: string, index?: number) => void
}

export function FileImagePreview({
  maxImages = 3,
  src,
  children,
  onImageChange,
}: FileImagePreviewProps) {
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
    <>
      {showChildren && children}
      {src &&
        (typeof src === 'string' ? (
          <ImagePreview
            src={src}
            onImageClick={() => handleShowImage(0)}
            onCloseClick={() => handleRemoveImage(0)}
          />
        ) : (
          src.map((x, i) => (
            <ImagePreview
              key={i}
              src={x}
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
    </>
  )
}

interface ImagePreviewProps {
  src?: string
  onImageClick?: () => void
  onCloseClick?: () => void
}

function ImagePreview({ src, onImageClick, onCloseClick }: ImagePreviewProps) {
  return (
    <div className='relative h-12 w-12 '>
      <img
        src={src}
        alt='thumbnail'
        className='pointer-events-none h-full w-full rounded-md border border-gray-300 object-cover'
      />
      <button
        type='button'
        onClick={onImageClick}
        className='absolute inset-0 h-full w-full cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-gray-400'
      />
      <button
        type='button'
        onClick={onCloseClick}
        className='-top-[8px] absolute left-[38px] flex cursor-pointer items-center justify-center rounded-full border bg-primary-800 hover:bg-primary-700'
      >
        <CloseIcon size={16} className='fill-white' />
      </button>
    </div>
  )
}
