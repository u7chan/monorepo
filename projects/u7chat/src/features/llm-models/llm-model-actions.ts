'use server'

import { redirect } from 'next/navigation'

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
  redirect(`/?model=${model}`)
}
