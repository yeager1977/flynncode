const PREFIX = "opencode.session-history.consent."

export function historyConsentKey(sessionID: string): string {
  return `${PREFIX}${sessionID}`
}

export function loadHistoryConsent(sessionID: string): boolean {
  if (typeof localStorage !== "object") return false
  return localStorage.getItem(historyConsentKey(sessionID)) === "1"
}

export function saveHistoryConsent(sessionID: string, consented: boolean): void {
  if (typeof localStorage !== "object") return
  if (consented) localStorage.setItem(historyConsentKey(sessionID), "1")
  else localStorage.removeItem(historyConsentKey(sessionID))
}
