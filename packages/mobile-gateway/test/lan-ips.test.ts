import { describe, expect, test } from "bun:test"
import { buildLauncherUrls, listLanIPv4, listTailnetIPv4 } from "../src/lan-ips"

describe("listLanIPv4", () => {
  test("keeps all RFC1918 ranges, drops loopback, container bridges, and IPv6", () => {
    const result = listLanIPv4({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      eth0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false } as never],
      "br-1a2b3c": [{ address: "172.18.0.1", family: "IPv4", internal: false } as never],
      veth9f: [{ address: "172.19.0.1", family: "IPv4", internal: false } as never],
      virbr0: [{ address: "192.168.122.1", family: "IPv4", internal: false } as never],
      eth1: [{ address: "10.0.0.5", family: "IPv4", internal: false } as never],
      wlan0: [{ address: "172.20.10.3", family: "IPv4", internal: false } as never],
    })
    expect(result).toEqual(["10.0.0.5", "172.20.10.3", "192.168.1.42"])
  })

  test("drops public, link-local, and tailnet addresses", () => {
    const result = listLanIPv4({
      eth0: [{ address: "203.0.113.7", family: "IPv4", internal: false } as never],
      eth1: [{ address: "169.254.1.1", family: "IPv4", internal: false } as never],
      tailscale0: [{ address: "100.90.1.2", family: "IPv4", internal: false } as never],
      eth2: [{ address: "172.32.0.1", family: "IPv4", internal: false } as never],
    })
    expect(result).toEqual([])
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
