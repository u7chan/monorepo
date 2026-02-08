import { SpinnerIcon } from '#/client/components/svg/spinner-icon'

export function RouteLoading() {
  return (
    <div className='flex min-h-[40vh] w-full flex-col items-center justify-center gap-3 text-slate-500'>
      <SpinnerIcon />
      <p className='text-sm'>Loading page...</p>
    </div>
  )
}
