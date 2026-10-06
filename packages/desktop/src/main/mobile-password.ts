export type PasswordStore = {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export function getOrCreateMobilePhonePassword(store: PasswordStore, key: string, generate: () => string) {
  const existing = store.get(key)
  if (existing) return existing
  const next = generate()
  store.set(key, next)
  return next
}
