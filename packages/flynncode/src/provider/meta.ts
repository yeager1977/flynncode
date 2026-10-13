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

export * as ProviderMeta from "./meta"
