import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { CheckIcon } from '#/client/shared/icons/check-icon'
import { CopyIcon } from '#/client/shared/icons/copy-icon'
import { EyeIcon } from '#/client/shared/icons/eye-icon'
import { SparkleIcon } from '#/client/shared/icons/sparkle-icon'

export interface CodeBlockPreviewButtonProps {
  onClick: () => void
  pending?: boolean
  disabled?: boolean
}

export function CodeBlockPreviewButton({ onClick, pending, disabled }: CodeBlockPreviewButtonProps) {
  return (
    <IconButton
      label={pending ? 'Checking preview' : 'Preview code block'}
      onClick={onClick}
      disabled={pending || disabled}
      className='relative inline-flex h-8 w-8 rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out hover:bg-gray-200 hover:text-gray-800 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
    >
      {pending ? (
        <svg viewBox='0 0 24 24' aria-hidden='true' fill='none' className='h-[18px] w-[18px] animate-spin'>
          <circle cx='12' cy='12' r='9' strokeWidth='2.5' className='stroke-current opacity-25' />
          <path d='M21 12a9 9 0 0 0-9-9' strokeWidth='2.5' strokeLinecap='round' className='stroke-current' />
        </svg>
      ) : (
        <EyeIcon size={18} className='stroke-current' />
      )}
    </IconButton>
  )
}

export interface CodeBlockPreviewLinkProps {
  href: string
}

export function CodeBlockPreviewLink({ href }: CodeBlockPreviewLinkProps) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noopener noreferrer'
      aria-label='Preview code block'
      className='relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
    >
      <EyeIcon size={18} className='stroke-current' />
    </a>
  )
}

export interface CodeBlockGenerateButtonProps {
  onClick: () => void
  pending?: boolean
  disabled?: boolean
}

export function CodeBlockGenerateButton({ onClick, pending, disabled }: CodeBlockGenerateButtonProps) {
  return (
    <IconButton
      label={pending ? 'Generating preview' : 'Generate preview'}
      onClick={onClick}
      disabled={pending || disabled}
      className='relative inline-flex h-8 w-8 rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out hover:bg-gray-200 hover:text-gray-800 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
    >
      {pending ? (
        <svg viewBox='0 0 24 24' aria-hidden='true' fill='none' className='h-[18px] w-[18px] animate-spin'>
          <circle cx='12' cy='12' r='9' strokeWidth='2.5' className='stroke-current opacity-25' />
          <path d='M21 12a9 9 0 0 0-9-9' strokeWidth='2.5' strokeLinecap='round' className='stroke-current' />
        </svg>
      ) : (
        <SparkleIcon size={18} className='stroke-current' />
      )}
    </IconButton>
  )
}

interface CodeBlockCopyButtonProps {
  copied: boolean
  onClick: () => void
  disabled?: boolean
}

export function CodeBlockCopyButton({ copied, onClick, disabled }: CodeBlockCopyButtonProps) {
  return (
    <IconButton
      label={copied ? 'Copied code block' : 'Copy code block'}
      onClick={onClick}
      disabled={copied || disabled}
      className={`relative inline-flex h-8 w-8 rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out dark:text-gray-300 ${
        copied
          ? 'text-emerald-600 disabled:opacity-100 dark:text-emerald-400'
          : 'hover:bg-gray-200 hover:text-gray-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-white dark:disabled:hover:bg-transparent dark:disabled:hover:text-gray-300'
      }`}
    >
      <span className='relative h-[18px] w-[18px]' aria-hidden='true'>
        <span
          className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
            copied ? '-translate-y-0.5 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100'
          }`}
        >
          <CopyIcon size={18} className='stroke-current' />
        </span>
        <span
          className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
            copied ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-0.5 scale-90 opacity-0'
          }`}
        >
          <CheckIcon size={18} className='stroke-current' />
        </span>
      </span>
    </IconButton>
  )
}
