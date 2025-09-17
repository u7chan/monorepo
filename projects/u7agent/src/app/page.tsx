import { Chat } from '@/features/chat/chat'

export default function Page() {
  return (
    <div className='flex justify-center'>
      <div className='w-full max-w-lg p-4'>
        <Chat model='gpt-4.1-mini' />
      </div>
    </div>
  )
}
