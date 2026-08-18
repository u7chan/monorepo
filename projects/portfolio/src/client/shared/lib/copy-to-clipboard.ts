export async function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
  } else {
    const input = document.createElement('textarea')
    input.value = text
    document.body.appendChild(input)
    try {
      input.select()
      if (!document.execCommand('copy')) {
        throw new Error('Failed to copy text to clipboard')
      }
    } finally {
      document.body.removeChild(input)
    }
  }
}
