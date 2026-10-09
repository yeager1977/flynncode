export type MachineSyncPhase = "idle" | "offline" | "mismatch" | "unauthorized" | "paused" | "unpaired"

export type MachineSyncStatus = {
  paired: boolean
  peerName: string | null
  paused: boolean
  phase: MachineSyncPhase
  online: boolean
  lastSuccess: number | null
  received: number
  sent: number
  missingDirectories: string[]
  backlog: { done: number; total: number } | null
  failures: Array<{ id: string; error: string }>
  lastError: string | null
  /** Set while the LAN gateway is wanted but could not start (e.g. port 4097 busy). */
  gatewayError: string | null
  machineName: string
  addresses: string[]
}

export type MachineSyncPairingCode = { code: string; expiresAt: number; machineName: string; addresses: string[] }

export type MachineSyncPairResult = { ok: true } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }

export type MachineSyncPrefs = { sections: Record<string, unknown>; updatedAt: number }

export type MachineSyncPlatform = {
  status(): Promise<MachineSyncStatus>
  subscribe(cb: (status: MachineSyncStatus) => void): () => void
  createPairingCode(): Promise<MachineSyncPairingCode>
  pair(input: { host: string; code: string }): Promise<MachineSyncPairResult>
  syncNow(): Promise<MachineSyncStatus>
  setPaused(paused: boolean): Promise<void>
  unpair(): Promise<void>
  /** Returns newer prefs the desktop already holds, for this window to apply. */
  pushPrefs(prefs: MachineSyncPrefs): Promise<MachineSyncPrefs | null>
  onPeerPrefs(cb: (prefs: MachineSyncPrefs) => void): () => void
}
