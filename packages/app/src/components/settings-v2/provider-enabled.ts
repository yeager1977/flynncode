export function setProviderEnabled(disabled: readonly string[], providerID: string, enabled: boolean) {
  if (enabled) return disabled.filter((id) => id !== providerID)
  if (disabled.includes(providerID)) return [...disabled]
  return [...disabled, providerID]
}

// Config patch that deletes a provider defined in the config file: the server removes a provider whose
// entry is empty, and a deleted provider no longer needs its disabled_providers ban.
export function removeProviderPatch(disabled: readonly string[], providerID: string) {
  return { provider: { [providerID]: {} }, disabled_providers: setProviderEnabled(disabled, providerID, true) }
}

export function providerRows(input: {
  connected: { id: string; name: string }[]
  disabled: readonly string[]
  configuredNames: Record<string, string>
}) {
  const seen = new Set(input.connected.map((item) => item.id))
  const disabled = new Set(input.disabled)
  const rows = input.connected.map((item) => ({
    id: item.id,
    name: item.name,
    enabled: !disabled.has(item.id),
  }))
  for (const id of input.disabled) {
    if (seen.has(id)) continue
    rows.push({ id, name: input.configuredNames[id] ?? id, enabled: false })
  }
  return rows
}
