import {
  headerRow,
  modelRow,
  type HeaderRow,
  type ModelErr,
  type ModelRow,
} from "@/components/dialog-custom-provider-form"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type EditForm = {
  baseURL: string
  apiKey: string
  headers: HeaderRow[]
  models: ModelRow[]
}

export type ProviderAuthKind = "env" | "api" | "oauth"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isConfigCustomProvider(entry: unknown) {
  if (!isRecord(entry)) return false
  if (entry.npm !== OPENAI_COMPATIBLE) return false
  if (!isRecord(entry.models) || Object.keys(entry.models).length === 0) return false
  return true
}

export function providerAuthKind(source: string | undefined): ProviderAuthKind {
  if (source === "env") return "env"
  if (source === "custom") return "oauth"
  return "api"
}

export function canEditProvider(protocol: "v1" | "v2") {
  return protocol === "v1"
}

export function providerEditPrefill(input: { provider: unknown; configCustom: boolean }) {
  const provider = isRecord(input.provider) ? input.provider : undefined
  const options = provider && isRecord(provider.options) ? provider.options : {}

  const baseURL = typeof options.baseURL === "string" ? options.baseURL : ""
  const headers = isRecord(options.headers)
    ? Object.entries(options.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => ({ ...headerRow(), key, value }))
    : []
  const models =
    input.configCustom && provider && isRecord(provider.models)
      ? Object.entries(provider.models).map(([id, model]) => ({
          ...modelRow(),
          id,
          name: isRecord(model) && typeof model.name === "string" ? model.name : "",
        }))
      : []

  return { baseURL, headers, models }
}

export function validateProviderEdit(input: {
  form: EditForm
  t: Translator
  configCustom: boolean
  existing: unknown
}) {
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const urlError =
    input.configCustom && !baseURL
      ? input.t("provider.custom.error.baseURL.required")
      : baseURL && !/^https?:\/\//.test(baseURL)
        ? input.t("provider.custom.error.baseURL.format")
        : undefined

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const seenModels = new Set<string>()
  const models = input.configCustom
    ? input.form.models.map((m) => {
        const id = m.id.trim()
        const idError = !id
          ? input.t("provider.custom.error.required")
          : seenModels.has(id)
            ? input.t("provider.custom.error.duplicate")
            : (() => {
                seenModels.add(id)
                return undefined
              })()
        const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined
        return { id: idError, name: nameError }
      })
    : input.form.models.map((): ModelErr => ({}))
  const modelsValid = models.every((m) => !m.id && !m.name)
  const modelConfig = Object.fromEntries(input.form.models.map((m) => [m.id.trim(), { name: m.name.trim() }]))

  const err = { baseURL: urlError }
  const ok = !urlError && headersValid && modelsValid
  if (!ok) return { err, headers, models }

  const existing = isRecord(input.existing) ? input.existing : {}
  const existingOptions = isRecord(existing.options) ? existing.options : {}
  const options: Record<string, unknown> = { ...existingOptions }
  if (baseURL) options.baseURL = baseURL
  else delete options.baseURL
  if (Object.keys(headerConfig).length) options.headers = headerConfig
  else delete options.headers

  const key = apiKey || undefined
  if (key) delete options.apiKey

  const provider: Record<string, unknown> = { ...existing, options }
  if (input.configCustom) provider.models = modelConfig

  // Only persist a provider entry when there is a config entry to update or
  // something to write. Writing an empty entry for a built-in provider with no
  // config would flip its effective source from `api` to `config`, so a key-only
  // save (which goes to the auth store) must not create one.
  const hasSomething = Object.keys(existing).length > 0 || !!baseURL || Object.keys(headerConfig).length > 0
  if (!hasSomething) return { err, headers, models, result: { key } }

  return { err, headers, models, result: { key, provider } }
}