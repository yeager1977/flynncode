import { useParams, useSearchParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { isContributorAcked, markContributorAcked } from "./contributor-models"

export function useContributorAck() {
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ draftId?: string }>()
  const sdk = useSDK()

  const [store, setStore] = persisted(
    Persist.global("meta-contributor-ack"),
    createStore<Record<string, number>>({}),
  )

  const scopeKey = () => {
    if (params.id) return `session:${params.id}`
    // Per-draft token so two drafts never share an ack. Falls back to the
    // directory key only on legacy routes without a draftId.
    if (search.draftId) return `draft:${search.draftId}`
    return `draft:${base64Encode(sdk().directory)}`
  }

  const acked = (key: string) => {
    if (isContributorAcked(key)) return true
    // Draft scopes are memory-only; never consult the persisted store for them.
    if (key.startsWith("draft:")) return false
    if (!store[key]) return false
    markContributorAcked(key)
    return true
  }

  const record = (key: string) => {
    markContributorAcked(key)
    // Only session scopes persist; draft scopes stay memory-only.
    if (!key.startsWith("session:")) return
    setStore(key, Date.now())
  }

  return { scopeKey, acked, record }
}
