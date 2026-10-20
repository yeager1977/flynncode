import { describe, expect, test } from "bun:test"
import { needsInteractiveTerminal } from "../../src/tool/shell/prompt"

describe("needsInteractiveTerminal", () => {
  test("treats sudo, ssh -t, su, and passwd as interactive", () => {
    expect(needsInteractiveTerminal("sudo id", undefined)).toBe(true)
    expect(needsInteractiveTerminal("FOO=1 ssh -t host", undefined)).toBe(true)
    expect(needsInteractiveTerminal("  su -", undefined)).toBe(true)
    expect(needsInteractiveTerminal("passwd", undefined)).toBe(true)
  })

  test("does not treat ordinary commands as interactive", () => {
    expect(needsInteractiveTerminal("ls", undefined)).toBe(false)
    expect(needsInteractiveTerminal("git status", undefined)).toBe(false)
    expect(needsInteractiveTerminal("echo sudo", undefined)).toBe(false)
  })

  test("runs ssh without -t on the normal path", () => {
    expect(needsInteractiveTerminal("ssh hubble 'tail -25 /var/log/nginx/access.log'", undefined)).toBe(false)
    expect(needsInteractiveTerminal("ssh -o BatchMode=yes -o ConnectTimeout=8 hubble uptime", undefined)).toBe(false)
    // The remote command's own flags do not count as ssh options.
    expect(needsInteractiveTerminal("ssh host 'sudo -t id'", undefined)).toBe(false)
    // -l takes a value, so "tom" is not a cluster containing -t.
    expect(needsInteractiveTerminal("ssh -l tom host ls", undefined)).toBe(false)
    expect(needsInteractiveTerminal("ssh -T host ls", undefined)).toBe(false)
  })

  test("hands off ssh that asks for a terminal", () => {
    expect(needsInteractiveTerminal("ssh -t starship 'sudo dpkg -i /tmp/app.deb'", undefined)).toBe(true)
    expect(needsInteractiveTerminal("ssh -tt host", undefined)).toBe(true)
    expect(needsInteractiveTerminal("ssh -o BatchMode=yes -At host 'sudo reboot'", undefined)).toBe(true)
  })

  test("keeps sudo -n on the normal path", () => {
    expect(needsInteractiveTerminal("sudo -n systemctl restart nginx", undefined)).toBe(false)
    expect(needsInteractiveTerminal("sudo -u postgres -n psql -c 'select 1'", undefined)).toBe(false)
    expect(needsInteractiveTerminal("sudo --non-interactive true", undefined)).toBe(false)
    // -u takes a value, so "nobody" is not a cluster containing -n.
    expect(needsInteractiveTerminal("sudo -u nobody id", undefined)).toBe(true)
    expect(needsInteractiveTerminal("sudo -E env", undefined)).toBe(true)
  })

  test("explicit flag wins over detection", () => {
    expect(needsInteractiveTerminal("ls", true)).toBe(true)
    expect(needsInteractiveTerminal("sudo id", false)).toBe(false)
    expect(needsInteractiveTerminal("ssh host", true)).toBe(true)
  })
})
