// Node runtime flags for the sidecar. On the dev channel the server writes a
// V8 heap snapshot just before the heap limit, so the recurring desktop OOM
// crash (V8 heap-exhaustion SIGTRAP in the Node sidecar) leaves the actual
// retainer behind instead of only minidump annotations.
export function sidecarNodeFlags(channel: string) {
  return channel === "dev" ? ["--heapsnapshot-near-heap-limit=1"] : []
}

export function sidecarArguments() {
  // The upstream opencode-mobile plugin activates its LAN push server and
  // tunnel only when the server process argv contains the literal `serve`
  // token (its approximation of "opencode serve"); the desktop launches the
  // server with no argv tokens, so pass the token it expects.
  return ["serve"]
}