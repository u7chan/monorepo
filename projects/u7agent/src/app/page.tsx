import { Chat } from '@/features/chat/chat'

export default function Page() {
  return (
    <div className='flex justify-center'>
      <div className='max-w-2xl flex-1 p-4'>
        <Chat model='gpt-4.1-mini' />
      </div>
    </div>
  )
}
