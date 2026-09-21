export const OMO_PLUGIN_IDS = ["oh-my-openagent", "oh-my-opencode"]

export function pluginId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

export function hasOmoPlugin(plugin: unknown): boolean {
  if (!Array.isArray(plugin)) return false
  return plugin.some((entry) => {
    const id = pluginId(entry)
    return id !== undefined && OMO_PLUGIN_IDS.includes(id)
  })
}

export function setOmoPlugin(plugin: unknown, enabled: boolean): unknown[] {
  const list = Array.isArray(plugin) ? [...plugin] : []
  const without = list.filter((entry) => {
    const id = pluginId(entry)
    return id === undefined || !OMO_PLUGIN_IDS.includes(id)
  })
  if (!enabled) return without
  if (hasOmoPlugin(list)) return list
  return [...without, "oh-my-openagent"]
}
