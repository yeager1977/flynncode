// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Instead of capping the chat panel at a fraction of the window
// (which forces the review pane to grow with the monitor), reserve a fixed
// minimum for the review pane and let the chat panel take everything else.
export const SESSION_PANEL_WIDTH_MIN = 450
export const REVIEW_PANE_WIDTH_MIN = 480
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 800
export const TASKS_PANEL_WIDTH_MIN = 280
export const TASKS_PANEL_WIDTH_MAX = 720

export function clampTasksPanelWidth(width: number) {
  return Math.min(TASKS_PANEL_WIDTH_MAX, Math.max(TASKS_PANEL_WIDTH_MIN, width))
}

export function sessionPanelWidthMax(input: { available: number; split: boolean; tasks?: number }) {
  const pane = input.split ? REVIEW_PANE_WIDTH_MIN_SPLIT : REVIEW_PANE_WIDTH_MIN
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - pane - (input.tasks ?? 0))
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: {
  width: number
  available: number | undefined
  split: boolean
  tasks?: number
}) {
  if (input.available === undefined) return input.width
  return Math.min(input.width, sessionPanelWidthMax({ available: input.available, split: input.split, tasks: input.tasks }))
}
