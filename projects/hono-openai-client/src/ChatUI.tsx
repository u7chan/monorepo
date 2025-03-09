interface Props {
  endpoint: string
  input?: string
  completion?: { model: string; content: string }
}

export function ChatUI({ endpoint, input, completion }: Props) {
  return (
    <div className='flex flex-col gap-2'>
      <form method='get' action={endpoint}>
        <div className='flex gap-2 w-[50vw]'>
          <textarea
            name='input'
            placeholder='質問してみよう！'
            className='flex-1 border rounded-md p-2'
          />
          <input
            type='submit'
            value='送信'
            className='bg-blue-500 text-white rounded-md px-4 py-2 cursor-pointer'
          />
        </div>
      </form>
      <div className='flex flex-col gap-2 w-[50vw]'>
        {input && (
          <div className='flex justify-end'>
            <div className='inline-block bg-blue-100 text-black p-2 rounded-lg whitespace-pre-wrap'>
              {input}
            </div>
          </div>
        )}
        <div className='flex flex-col gap-1'>
          <div className='flex justify-start'>
            <div className='bg-gray-200 text-black p-2 rounded-lg whitespace-pre-wrap'>
              {completion
                ? completion.content
                : 'こんにちは！\n何かお手伝いできることはありますか？'}
            </div>
          </div>
          {completion && (
            <div className='flex'>
              <div className='bg-gray-200 rounded-md px-2 py-1 text-black text-sm'>
                {completion.model}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
