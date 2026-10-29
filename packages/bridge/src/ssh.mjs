/**
 * 远程运维（`dsh-remote-ssh-ops` 的移植）：主机存储、指纹确认、远程执行。
 *
 * WHY IT SHELLS OUT TO `ssh.exe`: this app has no SSH library and must not grow one — a dependency that
 * parses keys and drives a channel would be a second, unaudited implementation of the thing the user's
 * operating system already ships. Windows 10+ carries OpenSSH, so the panel agrees with the `ssh` the
 * user would type in a terminal.
 *
 * WHY PASSWORD AUTH IS NOT OFFERED: `ssh` cannot read a password from a pipe (it insists on a terminal),
 * so a "password" field would be a button that always fails. Key auth and the system agent are supported;
 * anything else is refused with that sentence instead of hanging on a prompt nobody can answer.
 *
 * WHY A MANAGED `known_hosts` FILE: the first-connection fingerprint is the only thing standing between
 * the user and a man-in-the-middle. Delegating to the user's global known_hosts would mean either
 * auto-accepting (`StrictHostKeyChecking=no`, which defeats the point) or silently trusting a host key
 * some other tool accepted. This module keeps its own file, shows the SHA-256 fingerprint, and only
 * writes it after `sshConfirmHost` is called with an explicit confirmation.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataSubFile, ensureDir, dataSubDir } from './paths.mjs'

const CONNECT_TIMEOUT_MS = 15000
const EXEC_TIMEOUT_MS = 30000
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_COMMAND_LENGTH = 4000

/** Candidate binaries. The absolute path matters: a GUI app inherits a PATH without System32\OpenSSH. */
function sshCandidates() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  return [join(windir, 'System32', 'OpenSSH', 'ssh.exe'), 'ssh.exe']
}

function keyscanCandidates() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  return [join(windir, 'System32', 'OpenSSH', 'ssh-keyscan.exe'), 'ssh-keyscan.exe']
}

function probeBinary(candidates, args) {
  return new Promise((resolve) => {
    const [first, ...rest] = candidates
    execFile(first, args, { timeout: 5000, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, path: first, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      if (rest.length === 0) return resolve({ ok: false, path: null, error: String(stderr ?? error.message ?? error) })
      probeBinary(rest, args).then(resolve)
    })
  })
}

/** First existing candidate. `ssh-keyscan -h` exits non-zero just to print usage, so it cannot be probed like ssh. */
function findBinary(candidates) {
  for (const candidate of candidates) {
    if (candidate === 'ssh.exe' || candidate === 'ssh-keyscan.exe') return candidate
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Whether the machine can do SSH at all. `ok` means the probe ran; `available` carries the answer. */
export async function sshStatus() {
  const ssh = await probeBinary(sshCandidates(), ['-V'])
  const keyscan = findBinary(keyscanCandidates())
  return {
    ok: true,
    available: ssh.ok,
    sshPath: ssh.ok ? ssh.path : null,
    keyscanAvailable: keyscan !== null,
    version: ssh.ok ? (ssh.stderr || ssh.stdout).trim().split('\n')[0] : null,
    hint: ssh.ok
      ? null
      : '本机没有找到 OpenSSH 客户端。Windows 10/11 可在「设置 → 应用 → 可选功能」里添加 OpenSSH 客户端。',
  }
}

function hostsFile() {
  return dataSubFile('ssh', 'hosts.json')
}

function knownHostsFile() {
  ensureDir(dataSubDir('ssh'))
  return join(dataSubDir('ssh'), 'known_hosts')
}

/** Hosts as stored. A corrupt file degrades to an empty list rather than crashing the panel. */
export function sshListHosts() {
  try {
    const parsed = JSON.parse(readFileSync(hostsFile(), 'utf8'))
    if (!Array.isArray(parsed.hosts)) return { ok: true, hosts: [] }
    return { ok: true, hosts: parsed.hosts }
  } catch {
    return { ok: true, hosts: [] }
  }
}

function saveHosts(hosts) {
  writeFileSync(hostsFile(), `${JSON.stringify({ hosts }, null, 2)}\n`, 'utf8')
}

/** Host/user/port validation shared by add and probe. */
function validTarget({ host, port, user }) {
  const name = String(host ?? '').trim()
  if (name === '') return { ok: false, error: '请填写主机地址' }
  if (!/^[A-Za-z0-9._:\-[\]]+$/.test(name)) return { ok: false, error: `主机地址不合法：${name}` }
  const number = Number(port ?? 22)
  if (!Number.isInteger(number) || number < 1 || number > 65535) return { ok: false, error: '端口必须是 1–65535' }
  const account = String(user ?? '').trim()
  if (account === '') return { ok: false, error: '请填写用户名' }
  if (!/^[A-Za-z0-9._@\-]+$/.test(account)) return { ok: false, error: `用户名不合法：${account}` }
  return { ok: true, host: name, port: number, user: account }
}

/** Add (or replace) a host WITHOUT a fingerprint: connecting requires a confirmed one. */
export function sshAddHost({ name, host, port, user, keyPath } = {}) {
  const target = validTarget({ host, port, user })
  if (!target.ok) return { ok: false, error: target.error }

  const key = String(keyPath ?? '').trim()
  if (key !== '' && !existsSync(key)) return { ok: false, error: `私钥文件不存在：${key}` }

  const hosts = sshListHosts().hosts
  const label = String(name ?? '').trim() || `${target.user}@${target.host}`
  const existing = hosts.findIndex((entry) => entry.host === target.host && entry.port === target.port && entry.user === target.user)
  const record = {
    id: existing >= 0 ? hosts[existing].id : `ssh-${Date.now().toString(36)}`,
    name: label,
    host: target.host,
    port: target.port,
    user: target.user,
    keyPath: key,
    // A changed target keeps no fingerprint: the old one belongs to a different endpoint.
    fingerprint: existing >= 0 ? hosts[existing].fingerprint ?? null : null,
    addedAt: new Date().toISOString(),
  }
  if (existing >= 0) hosts[existing] = record
  else hosts.push(record)
  saveHosts(hosts)
  return { ok: true, host: record }
}

export function sshRemoveHost({ id } = {}) {
  const hosts = sshListHosts().hosts
  const next = hosts.filter((entry) => entry.id !== id)
  if (next.length === hosts.length) return { ok: false, error: '没有这个主机' }
  saveHosts(next)
  return { ok: true }
}

/**
 * The SHA-256 fingerprint of a public key blob, in `SHA256:base64` form (OpenSSH's display format).
 *
 * Exported for tests: this is the one piece of the flow that can be proven without a server, and it is
 * also the piece a wrong implementation would get subtly wrong (hashing the base64 TEXT instead of the
 * decoded blob produces a plausible-looking but useless fingerprint).
 */
export function fingerprintOf(base64Blob) {
  const blob = Buffer.from(String(base64Blob), 'base64')
  if (blob.length === 0) return null
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/**
 * Fetch the server's host key and return its fingerprint, WITHOUT trusting it yet.
 *
 * `ssh-keyscan` is the only way to see the key before a connection is trusted; it talks to the same
 * server the later `ssh` call will, so the fingerprint the user confirms is the one connections use.
 */
export async function sshProbeHost({ host, port } = {}) {
  const target = validTarget({ host, port, user: 'probe' })
  if (!target.ok) return { ok: false, error: target.error }

  const keyscan = findBinary(keyscanCandidates())
  if (!keyscan) return { ok: false, error: '本机没有 ssh-keyscan，无法在连接前读取服务器指纹' }

  const result = await new Promise((resolve) => {
    execFile(
      keyscan,
      ['-T', '8', '-p', String(target.port), target.host],
      { timeout: CONNECT_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    )
  })

  if (result.error) {
    return { ok: false, error: `读取服务器指纹失败：${(result.stderr || String(result.error.message ?? result.error)).trim().split('\n')[0]}` }
  }
  // Lines look like: `host ssh-ed25519 AAAA...`; the first key type wins (ed25519 preferred by ssh-keyscan).
  const line = result.stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry !== '' && !entry.startsWith('#'))
  if (!line) return { ok: false, error: '服务器没有返回主机密钥' }
  const parts = line.split(/\s+/)
  const blob = parts[2] ?? ''
  const fingerprint = fingerprintOf(blob)
  if (!fingerprint) return { ok: false, error: '服务器返回的主机密钥无法解析' }
  return { ok: true, host: target.host, port: target.port, keyType: parts[1] ?? '', fingerprint, line }
}

/** Record a fingerprint after the user confirmed it. Writes only the exact key that was shown. */
export function sshConfirmHost({ id, line, fingerprint } = {}) {
  const hosts = sshListHosts().hosts
  const host = hosts.find((entry) => entry.id === id)
  if (!host) return { ok: false, error: '没有这个主机' }
  const keyLine = String(line ?? '').trim()
  if (keyLine === '' || !keyLine.includes(' ')) return { ok: false, error: '缺少要确认的公钥内容' }
  const shown = String(fingerprint ?? '').trim()
  if (shown !== '' && fingerprintOf(keyLine.split(/\s+/)[2] ?? '') !== shown) {
    return { ok: false, error: '指纹与公钥内容不一致，已拒绝保存' }
  }

  const file = knownHostsFile()
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!existing.split('\n').some((entry) => entry.trim() === keyLine)) {
    writeFileSync(file, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${keyLine}\n`, 'utf8')
  }
  host.fingerprint = shown || fingerprintOf(keyLine.split(/\s+/)[2] ?? '')
  host.confirmedAt = new Date().toISOString()
  saveHosts(hosts)
  return { ok: true, host }
}

/**
 * Quote one argument for the REMOTE shell.
 *
 * `ssh` concatenates its arguments into a command string that the far side runs through a shell, so a
 * path is not an argv element there. Single quotes with `'` doubling are POSIX-safe and avoid the
 * expansion `sh -c` would otherwise perform.
 */
export function quoteRemote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Connection options that make a failure immediate instead of a prompt nobody can answer. */
function sshArgs(host) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsFile()}`,
    '-p',
    String(host.port),
  ]
  if (host.keyPath) args.push('-i', host.keyPath)
  args.push(`${host.user}@${host.host}`)
  return args
}

/** Run one remote command. Refuses until the fingerprint was confirmed. */
export async function sshExec({ id, command, timeoutMs } = {}) {
  const host = sshListHosts().hosts.find((entry) => entry.id === id)
  if (!host) return { ok: false, error: '没有这个主机' }
  if (!host.fingerprint) return { ok: false, error: '尚未确认服务器指纹：先在面板里读取并确认一次' }

  const text = String(command ?? '')
  if (text.trim() === '') return { ok: false, error: '命令不能为空' }
  if (text.includes('\u0000')) return { ok: false, error: '命令里含有非法字符' }
  if (text.length > MAX_COMMAND_LENGTH) return { ok: false, error: `命令太长（上限 ${MAX_COMMAND_LENGTH} 字符）` }

  const ssh = await probeBinary(sshCandidates(), ['-V'])
  if (!ssh.ok) return { ok: false, error: '本机没有可用的 ssh 客户端' }

  const limit = Math.min(Math.max(Number(timeoutMs) || EXEC_TIMEOUT_MS, 1000), 120000)
  const result = await new Promise((resolve) => {
    execFile(
      ssh.path,
      [...sshArgs(host), '--', text],
      { timeout: limit, windowsHide: true, shell: false, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    )
  })

  const output = result.stdout
  if (result.error) {
    const detail = (result.stderr || String(result.error.message ?? result.error)).trim()
    if (result.error.killed) return { ok: false, error: `命令超时（${Math.round(limit / 1000)} 秒）`, output }
    if (/Host key verification failed/i.test(detail)) {
      return { ok: false, error: '服务器指纹与记录不符：连接已拒绝。若服务器确实换过密钥，请删除该主机后重新确认。', output }
    }
    if (/Permission denied/i.test(detail)) return { ok: false, error: `认证失败：${detail.split('\n')[0]}`, output }
    return { ok: false, error: detail.split('\n')[0] || 'ssh 执行失败', output }
  }
  return { ok: true, output, stderr: result.stderr.trim(), exitCode: 0 }
}

/** Read one remote file by running `cat` through the same confirmed connection. */
export async function sshReadFile({ id, path } = {}) {
  const target = String(path ?? '').trim()
  if (target === '') return { ok: false, error: '请填写远程文件路径' }
  return await sshExec({ id, command: `cat -- ${quoteRemote(target)}` })
}
