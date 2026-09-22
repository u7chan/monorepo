export function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className='flex items-center gap-3 text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>
      <span>{children}</span>
      <span aria-hidden='true' className='min-w-0 flex-1 border-gray-300 border-t dark:border-gray-600' />
    </h3>
  )
}
