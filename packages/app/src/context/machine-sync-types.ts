/** `peer-paused`: the other computer is reachable but has paused sync. */
/** `clock-skew`: the two computers' clocks differ by more than a minute, so signed requests are refused. */
export type MachineSyncPhase =
  | "idle"
  | "offline"
  | "mismatch"
  | "unauthorized"
  | "paused"
  | "peer-paused"
  | "clock-skew"
  | "unpaired"

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
  /** A pulled global config is written but waits for "Reload to apply"; `from` names its machine. */
  configReloadPending: { from: string; busy: boolean } | null
  /** Set while the LAN gateway is wanted but could not start (e.g. port 4097 busy). */
  gatewayError: string | null
  machineName: string
  addresses: string[]
}

export type MachineSyncPairingCode = { code: string; expiresAt: number; machineName: string; addresses: string[] }

/**
 * `prefs` says what happened to app preferences: `kept` (this computer's win,
 * including when `theirs` was asked but the other computer has none), `adopted`
 * (the other computer's were applied) or `unread` (`theirs` was asked but the
 * other computer's could not be fetched, so newest-wins applies as usual).
 */
export type MachineSyncPairResult =
  | { ok: true; prefs: "kept" | "adopted" | "unread" }
  | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }

export type MachineSyncPrefsChoice = "keep" | "theirs"

export type MachineSyncPrefs = { sections: Record<string, unknown>; updatedAt: number }

export type MachineSyncPlatform = {
  status(): Promise<MachineSyncStatus>
  subscribe(cb: (status: MachineSyncStatus) => void): () => void
  createPairingCode(): Promise<MachineSyncPairingCode>
  /**
   * `prefs` picks which computer's app preferences win once paired: `keep`
   * (default) pushes this computer's, `theirs` adopts the other computer's.
   */
  pair(input: { host: string; code: string; prefs?: MachineSyncPrefsChoice }): Promise<MachineSyncPairResult>
  syncNow(): Promise<MachineSyncStatus>
  /** Reloads this computer's instances so a pulled config takes effect, like saving settings does. */
  reloadConfig(input?: { force?: boolean }): Promise<MachineSyncStatus>
  setPaused(paused: boolean): Promise<void>
  unpair(): Promise<void>
  /** Returns newer prefs the desktop already holds, for this window to apply. */
  pushPrefs(prefs: MachineSyncPrefs): Promise<MachineSyncPrefs | null>
  onPeerPrefs(cb: (prefs: MachineSyncPrefs) => void): () => void
  /**
   * Fires after a successful pair: prefs to adopt with a fresh stamp (the
   * other computer's wins), or null to restamp and push this computer's.
   */
  onAdoptPrefs(cb: (prefs: MachineSyncPrefs | null) => void): () => void
}
