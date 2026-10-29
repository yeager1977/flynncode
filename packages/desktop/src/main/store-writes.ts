// Renderer stores persist through electron-store, which rewrites the whole file
// synchronously on the main process for every set. Buffer IPC writes per store
// and write each store once per burst.
export function createStoreWrites(write: (name: string, values: Record<string, unknown>) => void, delay = 300) {
  const pending = new Map<string, Map<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (name?: string) => {
    const names = name === undefined ? [...pending.keys()] : [name]
    names.forEach((store) => {
      const values = pending.get(store)
      pending.delete(store)
      if (values?.size) write(store, Object.fromEntries(values))
    })
    if (pending.size > 0 || timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  return {
    set(name: string, key: string, value: unknown) {
      const values = pending.get(name) ?? new Map<string, unknown>()
      values.set(key, value)
      pending.set(name, values)
      timer ??= setTimeout(() => {
        timer = undefined
        flush()
      }, delay)
    },
    // A buffered value is newer than the file; undefined means "read the store".
    pending: (name: string, key: string) => pending.get(name)?.get(key),
    drop(name: string, key?: string) {
      if (key === undefined) pending.delete(name)
      else pending.get(name)?.delete(key)
    },
    flush,
  }
}
