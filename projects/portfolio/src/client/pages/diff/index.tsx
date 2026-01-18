import ReactDiffViewer from 'react-diff-viewer'

export function Diff() {
  const oldCode = `line 1
line 2
line 3`

  const newCode = `line 1
modified line 2
line 3`

  return (
    <div className='h-screen overflow-y-auto bg-white p-4 dark:bg-gray-900'>
      <ReactDiffViewer oldValue={oldCode} newValue={newCode} splitView={true} />
    </div>
  )
}