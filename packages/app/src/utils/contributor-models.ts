export function contributorModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function isContributorModel(providerID: string, modelID: string): boolean {
  return providerID === "meta" && /^muse-.+-contributor$/.test(modelID)
}

const acked = new Set<string>()

export function isContributorAcked(key: string): boolean {
  return acked.has(key)
}

export function markContributorAcked(key: string): void {
  acked.add(key)
}
