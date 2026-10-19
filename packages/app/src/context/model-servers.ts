// Server options for a model id across provider endpoints. Pickers use this
// to surface "which server runs the job" as a first-class choice when the
// same model id exists on more than one connected provider.
export interface ModelServerInput {
  items: { id: string; provider: { id: string; name: string } }[]
  modelID: string
  current?: string
}

export interface ModelServerOption {
  id: string
  label: string
  providerID: string
  current: boolean
}

export function modelServers(input: ModelServerInput) {
  const providers = new Map<string, string>()
  for (const item of input.items) {
    if (item.id !== input.modelID) continue
    providers.set(item.provider.id, item.provider.name)
  }

  const names = [...providers.values()]
  const duplicated = new Set(names.filter((name) => names.filter((entry) => entry === name).length > 1))

  return [...providers.entries()]
    .sort(([aID, aName], [bID, bName]) => aName.localeCompare(bName) || aID.localeCompare(bID))
    .sort((entry, other) => (entry[0] === input.current ? -1 : other[0] === input.current ? 1 : 0))
    .map(([providerID, name]) => ({
      id: input.modelID,
      label: duplicated.has(name) ? `${name} (${providerID})` : name,
      providerID,
      current: providerID === input.current,
    }))
}

export * as ModelServers from "./model-servers"
