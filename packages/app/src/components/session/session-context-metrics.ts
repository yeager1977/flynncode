import type { AssistantMessage, Message } from "@flynncode/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Lookup = (providerID: string) => Provider | undefined

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  total: number
  usage: number | null
}

// Everything one provider/model spent in a chat, summed over its assistant messages.
export type SessionModelUsage = {
  providerID: string
  modelID: string
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  tokens: number
  cost: number
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const resolve = (providers: Provider[], lookup: Lookup | undefined, providerID: string, modelID: string) => {
  const listed = providers.find((item) => item.id === providerID)
  // A provider that is no longer connected is missing from the list; the lookup resolves it from the full catalog.
  const provider = listed?.models[modelID] ? listed : (lookup?.(providerID) ?? listed)
  const model = provider?.models[modelID]
  return {
    provider,
    model,
    providerLabel: provider?.name ?? providerID,
    modelLabel: model?.name ?? modelID,
    limit: model?.limit.context,
  }
}

const build = (messages: Message[] = [], providers: Provider[] = [], lookup?: Lookup): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const resolved = resolve(providers, lookup, message.providerID, message.modelID)
  const total = tokenTotal(message)

  return {
    message,
    ...resolved,
    input: message.tokens.input,
    total,
    usage: resolved.limit ? Math.round((total / resolved.limit) * 100) : null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = [], lookup?: Lookup) {
  return build(messages, providers, lookup)
}

// Tokens and cost per provider/model for one chat, most recently used first, so the first entry is the model
// currently doing the work. Assistant messages that have not reported tokens yet (still on their first step) are
// skipped, matching `getSessionContext`, which also ignores them.
export function getSessionModelUsage(
  messages: Message[] = [],
  providers: Provider[] = [],
  lookup?: Lookup,
): SessionModelUsage[] {
  const totals = messages.reduce((acc, message) => {
    if (message.role !== "assistant") return acc
    const tokens = tokenTotal(message)
    if (tokens <= 0) return acc
    const key = `${message.providerID}/${message.modelID}`
    const previous = acc.get(key)
    // Re-inserting moves the key to the end, so the map ends up ordered by last use.
    acc.delete(key)
    acc.set(key, {
      providerID: message.providerID,
      modelID: message.modelID,
      tokens: (previous?.tokens ?? 0) + tokens,
      cost: (previous?.cost ?? 0) + message.cost,
    })
    return acc
  }, new Map<string, Pick<SessionModelUsage, "providerID" | "modelID" | "tokens" | "cost">>())

  return [...totals.values()].reverse().map((entry) => {
    const resolved = resolve(providers, lookup, entry.providerID, entry.modelID)
    return { ...entry, providerLabel: resolved.providerLabel, modelLabel: resolved.modelLabel, limit: resolved.limit }
  })
}
