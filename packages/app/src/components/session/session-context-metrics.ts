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

const build = (
  messages: Message[] = [],
  providers: Provider[] = [],
  lookup?: (providerID: string) => Provider | undefined,
): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const listed = providers.find((item) => item.id === message.providerID)
  // A provider that is no longer connected is missing from the list; the lookup resolves it from the full catalog.
  const provider = listed?.models[message.modelID] ? listed : (lookup?.(message.providerID) ?? listed)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(
  messages: Message[] = [],
  providers: Provider[] = [],
  lookup?: (providerID: string) => Provider | undefined,
) {
  return build(messages, providers, lookup)
}
