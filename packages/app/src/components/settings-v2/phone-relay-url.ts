// The relay publish URL points at the deepthought host's gateway. Loopback,
// LAN, and tailnet hosts are all valid — this is a remote gateway URL, not a
// local endpoint — so the only rule is an http(s) scheme with a host.
export const isHttpUrl = (value: string) => /^https?:\/\/[^\s/:?#]+(:\d+)?([/?#].*)?$/i.test(value)