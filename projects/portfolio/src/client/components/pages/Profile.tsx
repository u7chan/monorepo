import { useState, type FC, type FormEvent } from 'react'
import { hc } from 'hono/client'

import type { AppType } from '../../../server/app'
import { FileImageInput, FileImagePreview } from '../input/FileImageInput'

const client = hc<AppType>('/')

export const Profile: FC = () => {
  const [uploadImage, setUploadImage] = useState('')

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

  const handleUploadImageChange = (src: string) => {
    setUploadImage(src)
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
        <FileImagePreview src={uploadImage} onImageChange={handleUploadImageChange}>
          <FileImageInput
            fileInputButton={(onClick) => (
              <button
                type='button'
                onClick={onClick}
                className='mb-4 rounded bg-primary-800 px-4 py-2 text-white hover:bg-primary-700'
              >
                ファイルを選択
              </button>
            )}
            onImageChange={handleUploadImageChange}
          />
        </FileImagePreview>
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
