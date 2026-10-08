import { describe, expect, test } from "bun:test"
import { buildLauncherUrls, listLanIPv4, listTailnetIPv4 } from "../src/lan-ips"

describe("listLanIPv4", () => {
  test("keeps 192.168.x.x only, drops loopback, container bridges, and IPv6", () => {
    const result = listLanIPv4({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      eth0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false } as never],
      eth1: [{ address: "10.0.0.5", family: "IPv4", internal: false } as never,
      ],
    })
    expect(result).toEqual(["192.168.1.42"])
  })

  test("builds launcher urls with /m path", () => {
    expect(buildLauncherUrls(["192.168.1.42"], 4097)).toEqual(["http://192.168.1.42:4097/m"])
  })
})

describe("listTailnetIPv4", () => {
  test("lists only 100.64/10 addresses", () => {
    const nic = (address: string) => ({
      address,
      family: "IPv4",
      internal: false,
      mac: "00:00:00:00:00:00",
      netmask: "255.0.0.0",
      cidr: null,
    }) as never
    const found = listTailnetIPv4({ tailscale0: [nic("100.90.1.2")], eth0: [nic("192.168.1.5")] })
    expect(found).toEqual(["100.90.1.2"])
  })
})
