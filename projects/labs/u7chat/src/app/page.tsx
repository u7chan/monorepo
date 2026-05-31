import { Chat } from '@/features/chat/chat'
import { fetchModels } from '@/features/llm-settings/actions'
import { ModelSelect } from '@/features/llm-settings/model-select'
import { StreamToggle } from '@/features/llm-settings/stream-toggle'

export default async function Page(props: PageProps<'/'>) {
  const { model, stream } = await props.searchParams
  const selectModel = typeof model === 'string' ? model : ''
  const streamValue = stream !== 'false'

  const models = await fetchModels()

  return (
    <div className='flex h-dvh justify-center overflow-hidden p-4'>
      <div className='flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-3'>
        <div className='flex shrink-0 items-center gap-2'>
          <StreamToggle defaultValue={streamValue} />
          <ModelSelect models={models} defaultValue={selectModel} />
        </div>
        <div className='flex min-h-0 flex-1 flex-col'>
          {selectModel && <Chat model={selectModel} stream={streamValue} />}
        </div>
      </div>
    </div>
  )
}
