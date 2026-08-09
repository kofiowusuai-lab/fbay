import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const LABELS = {
  monitor: 'io.fbay.monitor',
  dashboard: 'io.fbay.dashboard',
}

export function agentPath (label, home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}

/**
 * launchd, not a shell background job.
 *
 * A `nohup ... &` process dies with the terminal, does not come back after a
 * reboot, and does not restart if it crashes - and the failure is silent, which
 * for a monitor is the worst property: an empty Telegram chat looks identical
 * whether the market is quiet or the process has been dead for three days.
 * KeepAlive plus RunAtLoad turns "remember to start it" into "it is running".
 */
export function buildPlist ({ label, dir, args, env = {}, logPath }) {
  const entries = Object.entries({ PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', ...env })
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>EnvironmentVariables</key>
  <dict>
${entries.map(([k, v]) => `    <key>${k}</key><string>${v}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`
}

export async function loadAgent (label, home = os.homedir(), runImpl = run) {
  const p = agentPath(label, home)
  // bootout first so a re-install replaces cleanly rather than erroring.
  await runImpl('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {})
  await runImpl('launchctl', ['bootstrap', `gui/${process.getuid()}`, p])
  return { ok: true }
}

export async function unloadAgent (label, runImpl = run) {
  await runImpl('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {})
  return { ok: true }
}

export async function agentRunning (label, runImpl = run) {
  try {
    const { stdout } = await runImpl('launchctl', ['list'])
    const line = stdout.split('\n').find((l) => l.endsWith(label))
    if (!line) return { installed: false, running: false }
    const pid = line.trim().split(/\s+/)[0]
    return { installed: true, running: pid !== '-', pid: pid === '-' ? null : Number(pid) }
  } catch {
    return { installed: false, running: false }
  }
}

export function writeAgents ({ dir, nodeBin, provider, home = os.homedir(), fsImpl = fs }) {
  const agentsDir = path.join(home, 'Library', 'LaunchAgents')
  fsImpl.mkdirSync(agentsDir, { recursive: true })

  fsImpl.writeFileSync(agentPath(LABELS.monitor, home), buildPlist({
    label: LABELS.monitor,
    dir,
    args: [nodeBin, path.join(dir, 'src', 'cli.mjs'), 'run', '--limit', '6', '--parallel', '3'],
    env: provider ? { FBAY_LLM_PROVIDER: provider } : {},
    logPath: path.join(dir, 'monitor.log'),
  }))

  fsImpl.writeFileSync(agentPath(LABELS.dashboard, home), buildPlist({
    label: LABELS.dashboard,
    dir: path.join(dir, 'dashboard'),
    args: [path.join(dir, 'dashboard', 'node_modules', '.bin', 'next'), 'start', '-p', '3737'],
    logPath: path.join(dir, 'dashboard.log'),
  }))

  return { monitor: agentPath(LABELS.monitor, home), dashboard: agentPath(LABELS.dashboard, home) }
}
