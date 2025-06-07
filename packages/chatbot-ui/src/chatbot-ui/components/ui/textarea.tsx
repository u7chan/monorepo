import type * as React from 'react'

import { cn } from '#/chatbot-ui/components/ui/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot='textarea'
      className={cn(
        'flex w-full min-w-0 resize-none bg-transparent px-3 py-2 text-base outline-none transition-color selection:bg-primary selection:text-primary-foreground file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        'empty:overflow-hidden', // 空の場合はスクロールを無効化
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
