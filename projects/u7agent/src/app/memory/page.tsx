import { getShortTermMemory } from '@/features/memory/short-term-memory'

export default async function Page() {
  const shortTermMemory = await getShortTermMemory()

  return (
    <div className='min-h-screen bg-background'>
      <div className='container mx-auto px-4 py-8 max-w-4xl'>
        {/* Header Section */}
        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-foreground mb-2'>メモリ管理</h1>
          <p className='text-foreground/70'>エージェントの短期記憶の状態を確認できます</p>
        </div>

        {/* Memory Content Card */}
        <div className='bg-secondary/50 backdrop-blur-sm rounded-xl border border-border p-6'>
          <div className='flex items-center justify-between mb-4'>
            <h2 className='text-xl font-semibold text-foreground flex items-center gap-2'>
              <span className='w-2 h-2 bg-green-500 rounded-full'></span>
              短期記憶
            </h2>
            <div className='text-sm text-foreground/60 bg-background/50 px-3 py-1 rounded-full'>
              {shortTermMemory ? '記憶あり' : '記憶なし'}
            </div>
          </div>

          {shortTermMemory ? (
            <div className='bg-background/80 rounded-lg p-4 border border-border/50'>
              <div className='flex items-start justify-between mb-2'>
                <span className='text-sm font-medium text-foreground/80'>現在の記憶内容</span>
                <span className='text-xs text-foreground/50 bg-secondary/50 px-2 py-1 rounded'>
                  最終更新: {new Date().toLocaleString('ja-JP')}
                </span>
              </div>
              <div className='text-sm text-foreground/90 bg-secondary/30 p-4 rounded-md overflow-x-auto whitespace-pre-wrap font-mono max-h-96 overflow-y-auto'>
                {shortTermMemory}
              </div>
            </div>
          ) : (
            <div className='text-center py-12'>
              <div className='w-16 h-16 mx-auto mb-4 bg-secondary/30 rounded-full flex items-center justify-center'>
                <span className='text-2xl'>🧠</span>
              </div>
              <p className='text-foreground/60 text-lg mb-2'>メモリが空です</p>
              <p className='text-foreground/40 text-sm'>エージェントとの会話を開始すると、短期記憶が蓄積されます</p>
            </div>
          )}
        </div>

        {/* Memory Stats Card */}
        <div className='mt-6 grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div className='bg-background/50 backdrop-blur-sm rounded-lg border border-border/50 p-4'>
            <h3 className='text-sm font-medium text-foreground/80 mb-2 flex items-center gap-2'>📊 統計情報</h3>
            <div className='space-y-2'>
              <div className='flex justify-between text-sm'>
                <span className='text-foreground/60'>文字数:</span>
                <span className='text-foreground/90 font-mono'>
                  {shortTermMemory ? shortTermMemory.length.toLocaleString() : 0}
                </span>
              </div>
              <div className='flex justify-between text-sm'>
                <span className='text-foreground/60'>状態:</span>
                <span
                  className={`text-sm px-2 py-0.5 rounded-full ${
                    shortTermMemory
                      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                      : 'bg-gray-500/10 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {shortTermMemory ? 'アクティブ' : '空'}
                </span>
              </div>
            </div>
          </div>

          <div className='bg-background/50 backdrop-blur-sm rounded-lg border border-border/50 p-4'>
            <h3 className='text-sm font-medium text-foreground/80 mb-2 flex items-center gap-2'>💡 ヒント</h3>
            <p className='text-sm text-foreground/60'>
              短期記憶は会話のコンテキストを保持し、エージェントがより適切な応答を生成するために使用されます。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
