import Keyv from 'keyv'
import KeyvSqlite from '@keyv/sqlite'

const keyv = new Keyv(new KeyvSqlite('sqlite://memory.sqlite'))

export async function saveShortTermMemory(context: string) {
  await keyv.set('shortTerm', context)
}

export async function getShortTermMemory(): Promise<string> {
  return (await keyv.get('shortTerm')) || ''
}

export async function clearShortTermMemory() {
  await keyv.delete('shortTerm')
}
