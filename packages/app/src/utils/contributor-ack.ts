import { useParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { isContributorAcked, markContributorAcked } from "./contributor-models"

export function useContributorAck() {
  const params = useParams<{ id?: string }>()
  const sdk = useSDK()

  const [store, setStore] = persisted(
    Persist.global("meta-contributor-ack"),
    createStore<Record<string, number>>({}),
  )

  const scopeKey = () => {
    if (params.id) return `session:${params.id}`
    return `draft:${base64Encode(sdk().directory)}`
  }

  const acked = (key: string) => {
    if (isContributorAcked(key)) return true
    if (!store[key]) return false
    markContributorAcked(key)
    return true
  }

  const record = (key: string) => {
    markContributorAcked(key)
    setStore(key, Date.now())
  }

  return { scopeKey, acked, record }
}
