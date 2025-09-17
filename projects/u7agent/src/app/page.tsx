import { Chat } from '@/features/chat/chat'

export default function Page() {
  return (
    <div className='flex flex-col items-center justify-center p-4'>
      <div className='w-full max-w-lg rounded border border-gray-200 p-4'>
        <Chat model='gpt-4.1-mini' />
      </div>
    </div>
  )
}
