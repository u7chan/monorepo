'use server'

import { redirect } from 'next/navigation'

export async function fetchModels() {
  return ['model1', 'model2', 'model3']
}

export async function changeModel(model: string) {
  redirect(`/?model=${model}`)
}
