/**
 * SSH port: the parts that can be proven without a server.
 *
 * The network half — actually connecting — is deliberately absent: this machine has no SSH server, and a
 * suite that "passes" because it never dialled anything would be the exact false green this project keeps
 * calling out. What is proven here is the security-relevant logic: fingerprint formatting against a
 * published key, refusal to execute before a fingerprint was confirmed, argument quoting, and target
 * validation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the data root at a throwaway directory BEFORE importing: `paths.mjs` resolves it once at load.
const dataRoot = mkdtempSync(join(tmpdir(), 'cccn-ssh-'))
process.env.CCCN_DATA_DIR = dataRoot

const { finish, makeCheck } = await import('./harness.mjs')
const ssh = await import('../src/ssh.mjs')

const results = []
const check = makeCheck(results)

try {
  {
    // GitHub's published ed25519 host key and the fingerprint GitHub documents for it. Hashing the base64
    // TEXT instead of the decoded blob yields a different, plausible-looking value — which is why this is
    // pinned to a real published pair rather than compared against a second implementation here.
    const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
    const fingerprint = ssh.fingerprintOf(blob)
    check('fingerprint: matches the published SHA256', fingerprint === 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', fingerprint)
    check('fingerprint: refuses empty input', ssh.fingerprintOf('') === null)
  }

  {
    check('quote: plain path is single-quoted', ssh.quoteRemote('/etc/hosts') === "'/etc/hosts'")
    check('quote: embedded quote is escaped', ssh.quoteRemote("a'b") === "'a'\\''b'", ssh.quoteRemote("a'b"))
    check('quote: spaces survive', ssh.quoteRemote('/tmp/a b') === "'/tmp/a b'")
  }

  {
    const bad = ssh.sshAddHost({ host: 'example.com', port: 70000, user: 'root' })
    check('add: port range enforced', bad.ok === false && String(bad.error).includes('65535'), bad.error)
    const badUser = ssh.sshAddHost({ host: 'example.com', port: 22, user: 'root; rm -rf /' })
    check('add: user is validated', badUser.ok === false, badUser.error)
    const good = ssh.sshAddHost({ name: '测试机', host: 'example.com', port: 22, user: 'deploy' })
    check('add: stores the host', good.ok === true && good.host.fingerprint === null, JSON.stringify(good.host ?? good.error))
    const list = ssh.sshListHosts()
    check('list: returns the stored host', list.ok === true && list.hosts.length === 1, JSON.stringify(list.hosts))

    const execBeforeConfirm = await ssh.sshExec({ id: good.host.id, command: 'uptime' })
    check(
      'exec: refused until the fingerprint is confirmed',
      execBeforeConfirm.ok === false && String(execBeforeConfirm.error).includes('指纹'),
      execBeforeConfirm.error,
    )

    const unknown = await ssh.sshExec({ id: 'nope', command: 'uptime' })
    check('exec: unknown host is refused', unknown.ok === false && String(unknown.error).includes('没有这个主机'))

    const tampered = ssh.sshConfirmHost({ id: good.host.id, line: 'example.com ssh-ed25519 AAAA', fingerprint: 'SHA256:wrong' })
    check('confirm: a mismatched fingerprint is rejected', tampered.ok === false, tampered.error)

    const confirmed = ssh.sshConfirmHost({
      id: good.host.id,
      line: 'example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
      fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
    })
    check('confirm: matching fingerprint is stored', confirmed.ok === true && String(confirmed.host?.fingerprint).startsWith('SHA256:'), JSON.stringify(confirmed.host ?? confirmed.error))

    const removed = ssh.sshRemoveHost({ id: good.host.id })
    check('remove: deletes the host', removed.ok === true && ssh.sshListHosts().hosts.length === 0)
  }

  {
    const status = await ssh.sshStatus()
    check('status: reports availability as a fact', status.ok === true && typeof status.available === 'boolean', JSON.stringify(status))
    if (!status.available) {
      console.log('  SKIP  ssh 客户端不存在，真连接部分无法验证')
      results.push({ name: 'ssh connection (skipped: no ssh client)', ok: true })
    } else {
      const probe = await ssh.sshProbeHost({ host: '127.0.0.1', port: 1 })
      check('probe: a closed port fails with a sentence', probe.ok === false && typeof probe.error === 'string', probe.error)
    }
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(dataRoot, { recursive: true, force: true })
}

finish(results, 15000)
