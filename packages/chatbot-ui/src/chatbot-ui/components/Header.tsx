import { ThemeToggle } from './ThemeToggle'

export function Header() {
  return (
    <header className='border-b bg-card p-3'>
      <div className='container mx-auto flex max-w-4xl items-center justify-between'>
        <h1 className='font-bold text-xl'>Chatbot UI</h1>
        <ThemeToggle />
      </div>
    </header>
  )
}
