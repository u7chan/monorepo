import { Streamdown } from 'streamdown'

export default function Home() {
  const markdown = '# Hello World\n\nThis is **streaming** markdown!'

  return <Streamdown>{markdown}</Streamdown>
}
