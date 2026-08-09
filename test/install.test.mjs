import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlist, agentPath, writeAgents, agentRunning, LABELS } from '../src/install.mjs'

test('the plist restarts on crash and starts at login', () => {
  const p = buildPlist({ label: 'io.fbay.test', dir: '/x', args: ['/usr/bin/node', 'a.mjs'], logPath: '/x/l.log' })
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/, 'must survive a reboot')
  assert.match(p, /<key>KeepAlive<\/key>/, 'must come back after a crash')
  assert.match(p, /<key>SuccessfulExit<\/key>\s*<false\/>/, 'restart on failure, not on clean exit')
  assert.match(p, /ThrottleInterval<\/key><integer>60/, 'a crash loop must not spin')
})

test('the plist carries the working directory and log path', () => {
  const p = buildPlist({ label: 'l', dir: '/Users/me/fbay', args: ['/n'], logPath: '/Users/me/fbay/monitor.log' })
  assert.match(p, /<key>WorkingDirectory<\/key><string>\/Users\/me\/fbay<\/string>/)
  assert.match(p, /StandardOutPath<\/key><string>\/Users\/me\/fbay\/monitor\.log/)
  assert.match(p, /StandardErrorPath<\/key><string>\/Users\/me\/fbay\/monitor\.log/, 'errors must land in the same log, not be lost')
})

test('PATH is set explicitly because launchd does not inherit a login shell', () => {
  const p = buildPlist({ label: 'l', dir: '/x', args: ['/n'], logPath: '/l' })
  assert.match(p, /homebrew\/bin/)
})

test('provider env is passed through when set', () => {
  const p = buildPlist({ label: 'l', dir: '/x', args: ['/n'], env: { FBAY_LLM_PROVIDER: 'codex' }, logPath: '/l' })
  assert.match(p, /<key>FBAY_LLM_PROVIDER<\/key><string>codex<\/string>/)
})

test('writeAgents produces both agents in LaunchAgents', () => {
  const written = {}
  const fsImpl = { mkdirSync: () => {}, writeFileSync: (p, c) => { written[p] = c } }
  const r = writeAgents({ dir: '/Users/me/fbay', nodeBin: '/usr/bin/node', provider: 'codex', home: '/Users/me', fsImpl })
  assert.equal(r.monitor, agentPath(LABELS.monitor, '/Users/me'))
  assert.ok(written[r.monitor].includes('src/cli.mjs'))
  assert.ok(written[r.dashboard].includes('next'))
  assert.ok(written[r.dashboard].includes('3737'))
})

test('agentRunning reads a pid from launchctl output', async () => {
  const runImpl = async () => ({ stdout: '-\t0\tcom.other\n4212\t0\tio.fbay.monitor\n' })
  assert.deepEqual(await agentRunning('io.fbay.monitor', runImpl), { installed: true, running: true, pid: 4212 })
})

test('agentRunning distinguishes installed-but-stopped from absent', async () => {
  const stopped = async () => ({ stdout: '-\t0\tio.fbay.monitor\n' })
  assert.deepEqual(await agentRunning('io.fbay.monitor', stopped), { installed: true, running: false, pid: null })
  const absent = async () => ({ stdout: '' })
  assert.deepEqual(await agentRunning('io.fbay.monitor', absent), { installed: false, running: false })
})
