import { ModelV2 } from "@flynncode/core/model"
import type { Provider } from "./provider"
import type { ProviderDiscover } from "./discover"
import { ProviderTransform } from "./transform"

export function models(existing: Record<string, Provider.Model>, discovered: ProviderDiscover.Discovered[], baseURL: string) {
  const templates = Object.values(existing)
  return {
    ...existing,
    ...Object.fromEntries(
      discovered.flatMap((item) => {
        if (existing[item.id]) return []
        if (!/^muse-(spark|wonder)(?:-[a-z]+)*-\d+(?:\.\d+)*(?:-contributor)?$/.test(item.id)) return []
        const family = item.id.split("-").slice(0, 2).join("-")
        const template =
          templates.find((model) => model.api.id === item.id.replace("-full", "")) ??
          templates.find((model) => model.api.id.startsWith(`${family}-`) && !model.api.id.endsWith("-contributor")) ??
          templates.find((model) => model.api.id.startsWith(`${family}-`)) ??
          templates.find((model) => /^muse-(spark|wonder)-/.test(model.api.id))
        if (!template) return []
        // /models provides identities, not capabilities. Reuse the nearest Muse
        // family as fallback metadata until the catalog has an exact definition.
        const model: Provider.Model = {
          ...structuredClone(template),
          id: ModelV2.ID.make(item.id),
          name:
            item.name ??
            item.id
              .replace(/^muse-/, "Muse-")
              .replace(/-wonder(?:-full)?-1\.0/, item.id.includes("-full-") ? "-Wonder-Full" : "-Wonder")
              .split("-")
              .map((part) => part[0].toUpperCase() + part.slice(1))
              .join(" "),
          api: { id: item.id, npm: "@ai-sdk/openai", url: baseURL },
          status: "active",
          limit: {
            ...template.limit,
            context: item.context ?? template.limit.context,
            output: item.output ?? template.limit.output,
          },
          release_date: item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : "",
          variants: {},
        }
        model.variants = structuredClone(template.variants ?? ProviderTransform.variants(model))
        return [[item.id, model]]
      }),
    ),
  }
}

// Meta's subscription-billed API (a Muse Code subscription) refuses requests
// carrying classic `function` tools with 403 client_attestation_denied, no
// matter which headers present them. The only tool shape the subscription key
// serves is a single `namespace`-wrapped tool set on /v1/responses — which is
// what the muse code client (and only it) sends. Verified against api.meta.ai
// (2026-11-11): /responses with no tools or a namespace toolset serves the
// subscription key under any User-Agent, while function tools on /responses
// and every /v1/chat/completions request are refused. So the provider wraps
// outgoing function tools into one `opencode` namespace tool server-side and
// un-prefixes the dotted names the wrapper produces ("opencode.bash" →
// "bash") transparently at the fetch layer. The namespace and the request
// User-Agent identify honestly as opencode; nothing here mimics the muse
// client itself.
const NAMESPACE = "opencode"
const NAMESPACE_PREFIX = `${NAMESPACE}.`
const NAMESPACE_DESCRIPTION = "OpenCode tool set."

type Body = Record<string, unknown>
// Bun's global fetch type carries a `preconnect` member this module's simple
// impls do not implement; a structural type matches what the SDK callers use.
type FetchFunction = (requestInput: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isFunctionTool(item: unknown): item is Body {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false
  const record = item as Body
  return record.type === "function" && typeof record.name === "string" && record.name.length > 0
}

// ai-sdk echoes the assistant's previous function_call items back in `input`;
// prefix them so the model sees the dotted name it emitted, matching the
// namespace context. Non-call input items are untouched.
function prefixNamespacedInput(record: Body) {
  const input = record.input
  if (!Array.isArray(input)) return
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const call = item as Body
    if (call.type !== "function_call") continue
    if (typeof call.name !== "string" || call.name.startsWith(NAMESPACE_PREFIX)) continue
    call.name = NAMESPACE_PREFIX + call.name
  }
}

// A forced `tool_choice` for a wrapped tool would need to name the dotted
// form; prefix it the same way the history items are prefixed.
function prefixNamespacedToolChoice(record: Body) {
  const choice = record.tool_choice
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return
  const named = choice as Body
  if (typeof named.name !== "string" || named.name.startsWith(NAMESPACE_PREFIX)) return
  named.name = NAMESPACE_PREFIX + named.name
}

/**
 * Request transform for meta /responses bodies: wrap the outgoing function
 * tools into a single `opencode` namespace tool set and re-prefix echoed
 * function-call names. Bodies without (non-function) tools pass through
 * unchanged, and the transform is a no-op on bodies that are already wrapped.
 */
export function wrapToolsIntoNamespace(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body
  const record = parsed as Body
  const tools = record.tools
  if (!Array.isArray(tools) || tools.length === 0) return body
  if (!tools.every(isFunctionTool)) return body
  if (tools.some((item) => isFunctionTool(item) && typeof item.name === "string" && item.name.startsWith(NAMESPACE_PREFIX))) return body
  record.tools = [{ type: "namespace", name: NAMESPACE, description: NAMESPACE_DESCRIPTION, tools }]
  prefixNamespacedInput(record)
  prefixNamespacedToolChoice(record)
  return JSON.stringify(record)
}

/** Strip the namespace prefix from one tool-call name; true when changed. */
function stripNamespaceName(record: Body): boolean {
  const name = record.name
  if (typeof name !== "string" || !name.startsWith(NAMESPACE_PREFIX)) return false
  record.name = name.slice(NAMESPACE_PREFIX.length)
  return true
}

// A response payload's `output` array (top level for JSON responses, under
// `response` for the `response.completed` SSE event).
function stripNamespaceOutput(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  const output = (response as Body).output
  if (!Array.isArray(output)) return false
  let changed = false
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    if ((item as Body).type !== "function_call") continue
    changed = stripNamespaceName(item as Body) || changed
  }
  return changed
}

// The SSE events whose payloads carry a function-call name; the arguments
// string is model content, so it is never rewritten.
function patchSseData(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  const record = data as Body
  if (record.type === "response.output_item.added" || record.type === "response.output_item.done") {
    const item = record.item
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    if ((item as Body).type !== "function_call") return false
    return stripNamespaceName(item as Body)
  }
  if (record.type === "response.function_call_arguments.done") return stripNamespaceName(record)
  if (record.type === "response.completed") return stripNamespaceOutput(record.response)
  return false
}

// The namespace prefix only appears in function-call names, so non-data lines
// (event/type markers, keep-alives) never need parsing.
function patchSseLine(line: string): string {
  if (!line.startsWith("data:") || !line.includes(NAMESPACE_PREFIX)) return line
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice("data:".length))
  } catch {
    return line
  }
  if (!patchSseData(parsed)) return line
  return `data: ${JSON.stringify(parsed as Body)}`
}

// SSE frames split across fetch chunks, so re-assemble lines before patching.
function namespaceStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) controller.enqueue(encoder.encode(`${patchSseLine(line)}\n`))
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(patchSseLine(buffer)))
      },
    }),
  )
}

// Strip wrapped tool-call names from a non-streaming /responses JSON body.
function patchJsonResponse(response: Response): Promise<Response> {
  return response.text().then((text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return response
    }
    if (!stripNamespaceOutput(parsed)) return response
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    return new Response(JSON.stringify(parsed as Body), { status: response.status, headers })
  })
}

/**
 * A fetch impl for meta model requests: wraps the request's function tools in
 * the namespace form the server attests and un-prefixes wrapped tool-call
 * names on the way back. Non-/responses URLs and error responses pass through
 * untouched.
 */
export function createResponsesFetch(fetchImpl: FetchFunction = fetch): FetchFunction {
  return async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof requestInput === "string" ? requestInput : requestInput instanceof URL ? requestInput.href : requestInput.url
    let responses = false
    try {
      responses = new URL(url).pathname.endsWith("/responses")
    } catch {}
    if (!responses) return fetchImpl(requestInput, init)
    let body = init?.body
    if (typeof body === "string" && (init?.method === undefined || init.method.toUpperCase() === "POST")) {
      body = wrapToolsIntoNamespace(body)
    }
    const response = await fetchImpl(requestInput, { ...init, body })
    if (!response.ok) return response
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream") && response.body) {
      return new Response(namespaceStream(response.body), { status: response.status, headers: response.headers })
    }
    if (contentType.includes("application/json")) return patchJsonResponse(response)
    return response
  }
}

export const responsesFetch: FetchFunction = createResponsesFetch()

export * as ProviderMeta from "./meta"
