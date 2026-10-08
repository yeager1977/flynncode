import type { NetworkInterfaceInfo } from "node:os"
import { networkInterfaces } from "node:os"

// Container and VM bridges carry private addresses the phone cannot reach;
// they are filtered by interface name so real 10/8 and 172.16/12 LANs remain.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|podman|cni|flannel|lxcbr|lxdbr|vboxnet|vmnet)/

export function listLanIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const found = Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((info) => info.family === "IPv4" && !info.internal && isPrivateIPv4(info.address))
    .map((info) => info.address)
  return [...new Set(found)].sort()
}

// RFC1918 ranges: 10/8, 172.16/12, 192.168/16.
function isPrivateIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172) return parts[1] >= 16 && parts[1] <= 31
  return parts[0] === 192 && parts[1] === 168
}

export function buildLauncherUrls(ips: string[], port: number) {
  return ips.map((ip) => `http://${ip}:${port}/m`)
}

export function listTailnetIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const found: string[] = []
  for (const list of Object.values(interfaces)) {
    if (!list) continue
    for (const info of list) {
      if (info.family !== "IPv4") continue
      if (info.internal) continue
      if (!isTailnetIPv4(info.address)) continue
      found.push(info.address)
    }
  }
  return [...new Set(found)].sort()
}

function isTailnetIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4) return false
  if (parts[0] !== 100) return false
  if (!Number.isInteger(parts[1]) || parts[1] < 64 || parts[1] > 127) return false
  return parts.slice(2).every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
}

export function buildStatusPayload(input: { port: number; ips: string[]; tailnetIps?: string[] }) {
  const tailnet = input.tailnetIps ?? listTailnetIPv4()
  return {
    port: input.port,
    lanUrls: input.ips.map((ip) => `http://${ip}:${input.port}`),
    launcherUrls: buildLauncherUrls(input.ips, input.port),
    tailnetUrls: tailnet.map((ip) => `http://${ip}:${input.port}`),
    tailnetLauncherUrls: buildLauncherUrls(tailnet, input.port),
  }
}
