import mermaid from 'mermaid'
import { useCallback, useEffect, useRef, useState } from 'react'

const genRandomId = () => Number.parseInt(String(Math.random() * 1e15), 10).toString(36)

export function useMermaid(code: string, className?: string) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const id = useRef(`mermaid_${genRandomId()}`)

  const isMermaid = className && /^language-mermaid/.test(className.toLocaleLowerCase())

  const reRender = async () => {
    if (container && isMermaid) {
      try {
        const str = await mermaid.render(id.current, code)
        container.innerHTML = str.svg
      } catch (error) {
        container.innerHTML = String(error)
      }
    }
  }

  useEffect(() => {
    reRender()
  }, [container, isMermaid, code, id])

  const mermaidRef = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) {
      setContainer(node)
    }
  }, [])

  return {
    isMermaid,
    mermaidRef,
  }
}
