import { type Accessor, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@flynncode/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

// The router (server plugin) cannot read this client-side visibility store,
// so the mirror it consumes is explicit hides as `model_router.excludeModels`.
export function visibilityExcludeKeys(
  rows: Array<{ providerID: string; modelID: string; visibility: Visibility }>,
): string[] {
  return rows.filter((row) => row.visibility === "hide").map((row) => `${row.providerID}/${row.modelID}`)
}

// Set-level comparison: user rows and the config list can differ in order;
// non-string config entries count as different (a corrupt list must be
// rewritten, not adopted). An absent list (no `model_router.excludeModels`,
// e.g. the router has never been configured) counts as an empty one, so a
// store with nothing hidden is unchanged against it.
export function visibilityUnchanged(current: unknown, hidden: string[]): boolean {
  if (current === undefined) return hidden.length === 0
  if (!Array.isArray(current) || current.length !== hidden.length) return false
  const left = current.filter((key): key is string => typeof key === "string")
  // A non-string entry means the stored list is not the mirror this helper
  // compares — rewrite it rather than adopting it.
  if (left.length !== hidden.length) return false
  const right = [...hidden].sort()
  return left.sort().every((key, index) => key === right[index])
}

// The write decision itself, pulled out so the no-create rule can be unit
// tested without the debounce/server-sync plumbing around it. Returns
// undefined when nothing should be written: no `model_router` block to mirror
// into (never create the subtree for a user who has never configured the
// router — absent is a valid, inert state, not a gap to fill), or the
// existing excludeModels already matches.
export function visibilityWrite(
  router: { excludeModels?: unknown } | undefined,
  hidden: string[],
): Record<string, unknown> | undefined {
  if (router === undefined) return undefined
  if (visibilityUnchanged(router.excludeModels, hidden)) return undefined
  return { model_router: { ...router, excludeModels: hidden } }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(() => props.directory?.())

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    // Manage Models hides sync to the server as `model_router.excludeModels`
    // (the merge swaps `model_router` whole, so the patch carries the current
    // router object with excludeModels replaced). Debounced trailing: a
    // quick pass toggling several models writes once. Absent `model_router`
    // is never created here (see visibilityWrite) — the mirror only matters
    // once the router is configured, and the plugin stays inert without a
    // `model_router` key; creating the subtree for users who never touched it
    // would turn the router on for them. A no-op (the config already
    // matches, treating absent as an empty list) never writes either, so
    // selecting an already-visible model does not rebuild instances.
    const serverSync = useServerSync()
    const language = useLanguage()
    let visibilitySync: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => clearTimeout(visibilitySync))
    const syncVisibility = () => {
      clearTimeout(visibilitySync)
      visibilitySync = setTimeout(() => {
        const hidden = visibilityExcludeKeys(store.user)
        // Same cast the router settings editor uses for the config's
        // model_router block (packages/app/src/components/settings-v2/model-router.tsx).
        const config = serverSync().data.config as
          | { model_router?: { excludeModels?: unknown } }
          | undefined
        const patch = visibilityWrite(config?.model_router, hidden)
        if (!patch) return
        void serverSync()
          .updateConfig(patch)
          .catch(() => showToast({ variant: "error", title: language.t("settings.models.visibilitySyncFailed.title") }))
      }, 300)
    }

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
      syncVisibility()
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
