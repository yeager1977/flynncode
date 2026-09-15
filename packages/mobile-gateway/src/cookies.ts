export const SESSION_COOKIE = "oc_mobile_session"

const MAX_AGE_SECONDS = 2592000

export function readCookie(header: string | null | undefined, name: string) {
  if (!header) return
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=")
    if (separator === -1) continue
    if (segment.slice(0, separator).trim() !== name) continue
    return segment.slice(separator + 1).trim()
  }
  return
}

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`
}