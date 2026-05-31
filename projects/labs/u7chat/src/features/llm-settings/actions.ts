'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'

export async function fetchModels(): Promise<string[]> {
  const baseUrl = process.env.LITELLM_API_BASE_URL!
  const response = await fetch(new URL('models', baseUrl), {
    headers: {
      'x-litellm-api-key': process.env.LITELLM_API_KEY!,
    },
  })
  const { data }: { data: { id: string }[] } = await response.json()
  return data.map((x) => x.id).toSorted()
}

export async function changeModel(model: string) {
  const headersList = await headers()
  const currentUrl = new URL(headersList.get('referer') || '/', 'http://localhost')
  const searchParams = new URLSearchParams(currentUrl.search)
  searchParams.set('model', model)
  redirect(`/?${searchParams.toString()}`)
}

export async function changeStream(stream: boolean) {
  const headersList = await headers()
  const currentUrl = new URL(headersList.get('referer') || '/', 'http://localhost')
  const searchParams = new URLSearchParams(currentUrl.search)
  searchParams.set('stream', stream.toString())
  redirect(`/?${searchParams.toString()}`)
}
