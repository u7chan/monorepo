type DiffStatePayload = {
  beforeCode: string
  afterCode: string
}

const databaseName = 'portfolio'
const storeName = 'diff-state'
const recordKey = 'current'

function isClient() {
  return typeof window !== 'undefined'
}

function openDatabase() {
  if (!isClient() || !('indexedDB' in window)) {
    return null
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  if (!database) {
    return null
  }

  return new Promise<T | null>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    const request = action(store)

    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error)
    }
  })
}

export async function loadDiffState(): Promise<DiffStatePayload | null> {
  return withStore('readonly', (store) => store.get(recordKey))
}

export async function saveDiffState(state: DiffStatePayload) {
  await withStore('readwrite', (store) => store.put(state, recordKey))
}

export async function clearDiffState() {
  await withStore('readwrite', (store) => store.delete(recordKey))
}
