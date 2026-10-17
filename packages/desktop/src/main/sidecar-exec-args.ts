// Sidecar Node runtime args (e.g. --inspect for heap debugging), parsed from
// FLYNN_SIDECAR_EXEC_ARGS. The execArgv key must be omitted entirely when the
// variable is unset: utilityProcess treats an explicit `undefined` value as a
// present-but-invalid key and throws "Invalid value for execArgv" at launch.
export function sidecarExecArgv(raw: string | undefined) {
  const execArgs = (raw ?? "")
    .split(",")
    .map((arg) => arg.trim())
    .filter((arg) => arg !== "")
  return execArgs.length > 0 ? { execArgv: execArgs } : {}
}