// The built-in /loop command: the arguments decide which instructions the agent gets.

const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]
const MAX_DAY_STEP = 31

export type Interval = {
  cron: string
  /** Set when the requested interval could not be expressed exactly. */
  note?: string
}

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 }

/**
 * Turns `Nm`, `Nh` or `Nd` (seconds as `Ns`) into a 5-field cron. An interval that does not divide its unit evenly
 * is rounded to the nearest one that does, preferring the longer on a tie, and says so in `note`. Returns undefined
 * when the text is not an interval.
 */
export function parseInterval(text: string): Interval | undefined {
  const match = /^(\d+)([smhd])$/i.exec(text.trim())
  if (!match || Number(match[1]) < 1) return undefined
  const unit = match[2].toLowerCase() as keyof typeof UNIT_SECONDS
  const requested = Number(match[1]) * UNIT_SECONDS[unit]
  const result = plan(unit === "d" ? Number(match[1]) : undefined, requested)
  if (result.seconds === requested) return { cron: result.cron }
  return { cron: result.cron, note: `${text} cannot be scheduled exactly, so it was rounded to ${result.label}.` }
}

// `days` is given only for an interval requested in days, which needs no rounding through hours.
function plan(days: number | undefined, requested: number) {
  if (days === undefined) {
    // Seconds round up to a whole minute, and the minimum is one minute.
    const minutes = Math.ceil(requested / 60)
    const step = minutes < 60 ? nearest(minutes, [...MINUTE_STEPS, 60]) : 60
    if (step < 60)
      return { cron: `*/${step} * * * *`, seconds: step * 60, label: `every ${step} minute${step === 1 ? "" : "s"}` }
    const hours = Math.max(1, Math.round(minutes / 60))
    const hourStep = hours < 24 ? nearest(hours, [...HOUR_STEPS, 24]) : 24
    if (hourStep < 24)
      return {
        cron: `0 */${hourStep} * * *`,
        seconds: hourStep * 3600,
        label: `every ${hourStep} hour${hourStep === 1 ? "" : "s"}`,
      }
    return daily(Math.max(1, Math.round(hours / 24)))
  }
  return daily(days)
}

function daily(days: number) {
  const step = Math.min(days, MAX_DAY_STEP)
  return { cron: `0 0 */${step} * *`, seconds: step * 86400, label: `every ${step} day${step === 1 ? "" : "s"}` }
}

function nearest(value: number, steps: number[]) {
  return steps.reduce((best, step) => {
    const distance = Math.abs(step - value)
    const bestDistance = Math.abs(best - value)
    // The longer interval on a tie keeps a rounded loop from running more often than asked.
    return distance < bestDistance || (distance === bestDistance && step > best) ? step : best
  })
}

/** The instructions the agent receives for the arguments of `/loop`. */
export function instructions(args: string) {
  const text = args.trim()
  if (!text) return usage("No interval or prompt was given.")
  if (text.toLowerCase() === "stop") return stop()

  const first = text.split(/\s+/, 1)[0]
  const interval = parseInterval(first)
  if (!interval) return wakeup(text)
  const prompt = text.slice(first.length).trim()
  if (!prompt) return usage(`The interval ${first} was given without a prompt.`)
  return fixed(first, interval, prompt)
}

function fixed(token: string, interval: Interval, prompt: string) {
  return [
    `The user started a loop that repeats a prompt every ${token}.`,
    "",
    `Prompt: ${prompt}`,
    `Schedule: ${interval.cron} (5-field cron, server local time)`,
    ...(interval.note ? ["", `Note: ${interval.note} Tell the user about the rounding.`] : []),
    "",
    "Do this:",
    "1. Do the work of the prompt now, once, as if the user had just sent it.",
    `2. Then call cron_create with cron "${interval.cron}", recurring true and the prompt above, word for word. Schedule it even when step 1 finished the work.`,
    `3. Tell the user the cron you scheduled, that recurring jobs expire after 7 days, and that "/loop stop" cancels the loop.`,
    "",
    "Do not schedule anything else. If cron_create fails, tell the user why.",
  ].join("\n")
}

function wakeup(prompt: string) {
  return [
    "The user started a self-paced loop. There is no fixed interval: you decide when to run again.",
    "",
    `Prompt: ${prompt}`,
    "",
    "Do this:",
    "1. Do the work of the prompt now.",
    "2. If more work remains or you are waiting on something that changes over time, call schedule_wakeup with a prompt that repeats this loop's task, and a delaySeconds chosen from how fast things change (60 to 3600). Give a short reason.",
    "3. When the work is finished, schedule nothing and say that the loop is done.",
    "",
    'Each woken turn follows the same steps. "/loop stop" cancels a pending wakeup.',
  ].join("\n")
}

function stop() {
  return [
    "The user wants to stop this session's loops.",
    "",
    "Do this:",
    "1. Call cron_list.",
    "2. Call cron_delete for every job it lists, including a pending wakeup.",
    "3. Tell the user how many jobs you deleted, or that there were none.",
  ].join("\n")
}

function usage(problem: string) {
  return [
    `${problem} Do not schedule anything. Reply with this usage and nothing else:`,
    "",
    "/loop <interval> <prompt>  run the prompt now and then every interval; interval is Nm, Nh or Nd, e.g. 5m",
    "/loop <prompt>             run the prompt now and pace yourself with wakeups until the work is done",
    "/loop stop                 cancel this session's loops",
  ].join("\n")
}
