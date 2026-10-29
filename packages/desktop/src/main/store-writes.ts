// Renderer stores persist through electron-store, which rewrites the whole file
// synchronously on the main process for every set. Buffer IPC writes per store
// and write each store once per burst.
export function createStoreWrites(write: (name: string, values: Record<string, unknown>) => void, delay = 300) {
  const pending = new Map<string, Map<string, unknown>>()
  const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined }

  const flush = (name?: string) => {
    const names = name === undefined ? [...pending.keys()] : [name]
    names.forEach((store) => {
      const values = pending.get(store)
      pending.delete(store)
      if (values?.size) write(store, Object.fromEntries(values))
    })
    if (pending.size > 0 || state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  const drop = (name: string, key?: string) => {
    if (key === undefined) pending.delete(name)
    else pending.get(name)?.delete(key)
  }

  return {
    set(name: string, key: string, value: unknown) {
      const values = pending.get(name) ?? new Map<string, unknown>()
      values.set(key, value)
      pending.set(name, values)
      state.timer ??= setTimeout(() => {
        state.timer = undefined
        flush()
      }, delay)
    },
    // A buffered value is newer than the file; undefined means "read the store".
    pending: (name: string, key: string) => pending.get(name)?.get(key),
    drop,
    // A delete or clear can finish a move: a migration writes the new key into one store, then deletes the old copy
    // from another. Everything still buffered is written first, so an abrupt exit cannot lose both copies.
    settle(name: string, key?: string) {
      drop(name, key)
      flush()
    },
    flush,
  }
}
