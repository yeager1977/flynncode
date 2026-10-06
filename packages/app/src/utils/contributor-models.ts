const CONTRIBUTOR_MODELS = new Set([
  "meta/muse-spark-1.2-contributor",
  "meta/muse-spark-1.3-contributor",
])

export function contributorModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function isContributorModel(providerID: string, modelID: string): boolean {
  return CONTRIBUTOR_MODELS.has(contributorModelKey(providerID, modelID))
}

const acked = new Set<string>()

export function isContributorAcked(key: string): boolean {
  return acked.has(key)
}

export function markContributorAcked(key: string): void {
  acked.add(key)
}
