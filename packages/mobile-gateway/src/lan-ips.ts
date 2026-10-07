import type { NetworkInterfaceInfo } from "node:os"
import { networkInterfaces } from "node:os"

export function listLanIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const found: string[] = []
  for (const list of Object.values(interfaces)) {
    if (!list) continue
    for (const info of list) {
      if (info.family !== "IPv4") continue
      if (info.internal) continue
      // Only 192.168.x.x is listed: Docker bridges (172.16/12) and other
      // ranges are unreachable from the phone and would poison the QR code.
      if (!info.address.startsWith("192.168.")) continue
      found.push(info.address)
    }
  }
  return [...new Set(found)].sort()
}

export function buildLauncherUrls(ips: string[], port: number) {
  return ips.map((ip) => `http://${ip}:${port}/m`)
}

export function buildStatusPayload(input: { port: number; ips: string[] }) {
  return {
    port: input.port,
    lanUrls: input.ips.map((ip) => `http://${ip}:${input.port}`),
    launcherUrls: buildLauncherUrls(input.ips, input.port),
  }
}
