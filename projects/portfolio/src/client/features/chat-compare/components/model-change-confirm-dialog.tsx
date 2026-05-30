interface ModelChangeConfirmDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ModelChangeConfirmDialog({ open, onConfirm, onCancel }: ModelChangeConfirmDialogProps) {
  if (!open) return null

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center'>
      <div className='fixed inset-0 bg-black/50' onClick={onCancel} />
      <div className='relative z-10 mx-4 w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800'>
        <h3 className='font-semibold text-gray-900 text-lg dark:text-gray-100'>モデル選択の変更</h3>
        <p className='mt-2 text-sm text-gray-600 dark:text-gray-400'>
          モデル選択を変更すると現在の比較会話は破棄されます。続行しますか？
        </p>
        <div className='mt-4 flex justify-end gap-2'>
          <button
            type='button'
            onClick={onCancel}
            className='cursor-pointer rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
          >
            キャンセル
          </button>
          <button
            type='button'
            onClick={onConfirm}
            className='cursor-pointer rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400'
          >
            破棄して続行
          </button>
        </div>
      </div>
    </div>
  )
}
