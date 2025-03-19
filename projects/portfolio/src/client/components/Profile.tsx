import { useRef, useState, type FC, type FormEvent } from 'react'
import { hc } from 'hono/client'

import type { AppType } from '../../server/app'
import { CloseIcon } from './svg/CloseIcon'

const client = hc<AppType>('/')

export const Profile: FC = () => {
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    try {
      const res = await client.api.profile.$post({
        form: {
          name: `${formData.get('name')}`,
          email: `${formData.get('email')}`,
        },
      })
      if (!res.ok) {
        const { error } = (await res.json()) as unknown as { error: string }
        throw new Error(error)
      }
      alert('submit!')
    } catch (e: unknown) {
      alert(e instanceof Error && e.message)
    }
  }
  return (
    <form onSubmit={handleSubmit} className='p-4'>
      <h2 className='mb-4 font-semibold text-xl'>Profile</h2>
      <div className='mb-4'>
        <label className='mb-2 block text-gray-700' htmlFor='name'>
          Name
        </label>
        <input
          id='name'
          name='name'
          type='text'
          placeholder='Enter your name'
          className='w-full rounded-sm border border-gray-300 p-2'
        />
      </div>
      <div className='mb-4'>
        <label className='mb-2 block text-gray-700' htmlFor='email'>
          Email
        </label>
        <input
          id='email'
          name='email'
          type='email'
          placeholder='Enter your email'
          className='w-full rounded-sm border border-gray-300 p-2'
        />
      </div>
      <div className='mb-4'>
        <FileInputContainer />
      </div>
      <button
        type='submit'
        className='w-full rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700'
      >
        Save
      </button>
    </form>
  )
}

function FileInputContainer() {
  const [imagePreview, setImagePreview] = useState('')
  const [showImage, setShowImage] = useState(false)

  const handleFileChange = (src: string) => {
    setImagePreview(src)
  }

  const handleShowImage = () => {
    setShowImage(true)
  }

  const handleHideImage = () => {
    setShowImage(false)
  }

  const handleRemoveImage = () => {
    setImagePreview('')
  }

  return (
    <div>
      {!imagePreview && <FileInput onFileChange={handleFileChange} />}
      {imagePreview && (
        <ImagePreview
          src={imagePreview}
          onImageClick={handleShowImage}
          onCloseClick={handleRemoveImage}
        />
      )}
      {showImage && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/75'>
          <div className='relative w-full max-w-3xl p-4'>
            <img
              src={imagePreview}
              alt='preview'
              className='max-h-[80vh] w-full rounded object-contain shadow-lg'
            />
          </div>
          <button
            type='button'
            onClick={handleHideImage}
            className='absolute top-0 right-0 font-bold text-2xl text-white hover:text-gray-300'
          >
            <CloseIcon size={48} color='white' />
          </button>
        </div>
      )}
    </div>
  )
}

function FileInput({ onFileChange }: { onFileChange?: (src: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0]
      const reader = new FileReader()
      reader.onloadend = () => {
        onFileChange?.(reader.result as string)
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
      <button
        type='button'
        onClick={handleClick}
        className='mb-4 rounded bg-primary-800 px-4 py-2 text-white hover:bg-primary-700'
      >
        ファイルを選択
      </button>
    </div>
  )
}

function ImagePreview({
  src,
  onImageClick,
  onCloseClick,
}: { src?: string; onImageClick?: () => void; onCloseClick?: () => void }) {
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
        <CloseIcon size={16} color='white' />
      </button>
    </div>
  )
}
