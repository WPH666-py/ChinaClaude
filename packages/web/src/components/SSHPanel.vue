<script setup lang="ts">
/**
 * 远程运维 — SSH 主机、指纹确认、远程命令。
 *
 * WHY THE FINGERPRINT IS A SEPARATE STEP: the first connection is the only moment a user can tell a real
 * server from an impostor. This panel therefore never auto-accepts: 「读取指纹」 shows what the server
 * presented, and only 「确认并保存」 writes it. A host without a stored fingerprint refuses to run
 * anything — the bridge enforces that too, so this is not just UI theatre.
 *
 * WHY THERE IS NO PASSWORD FIELD: `ssh` cannot read a password from a pipe, so a password form would be a
 * button that always fails. Key files and the system agent are supported and said out loud.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface SshHost {
  id: string
  name: string
  host: string
  port: number
  user: string
  keyPath: string
  fingerprint: string | null
}

interface SshStatus {
  ok: boolean
  available: boolean
  sshPath: string | null
  keyscanAvailable: boolean
  version: string | null
  hint: string | null
}

interface SshAnswer<T = unknown> {
  ok: boolean
  error?: string
  output?: string
  host?: SshHost
  fingerprint?: string
  line?: string
  keyType?: string
  hosts?: SshHost[]
}

const emit = defineEmits<{ (e: 'close'): void }>()

function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

const status = ref<SshStatus | null>(null)
const hosts = ref<SshHost[]>([])
const error = ref('')
const notice = ref('')

const draft = ref({ name: '', host: '', port: '22', user: '', keyPath: '' })
const adding = ref(false)

/** The fingerprint shown for one host, before it is trusted. Indexed by id so two hosts never mix. */
const proposals = ref<Record<string, { fingerprint: string; line: string; keyType: string } | null>>({})
const probing = ref<Record<string, boolean>>({})

const activeId = ref<string | null>(null)
const command = ref('')
const running = ref(false)
const output = ref('')
const commandError = ref('')
const removeArmed = ref<string | null>(null)

const activeHost = computed(() => hosts.value.find((host) => host.id === activeId.value) ?? null)
const trustable = computed(() => hosts.value.filter((host) => host.fingerprint !== null))

async function call<T>(path: string, body?: unknown): Promise<SshAnswer<T> | SshStatus | null> {
  try {
    const response = body === undefined
      ? await fetch(`${baseUrl}${path}`)
      : await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return (await response.json()) as SshAnswer<T> | SshStatus
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
    return null
  }
}

async function load() {
  const answer = (await call('/api/ssh')) as SshAnswer | null
  if (answer && Array.isArray(answer.hosts)) hosts.value = answer.hosts
  const state = (await call('/api/ssh?what=status')) as SshStatus | null
  if (state) status.value = state
  if (hosts.value.length > 0 && activeId.value === null) activeId.value = hosts.value[0].id
}

async function addHost() {
  adding.value = true
  error.value = ''
  const answer = (await call('/api/ssh', {
    action: 'add',
    name: draft.value.name,
    host: draft.value.host,
    port: Number(draft.value.port),
    user: draft.value.user,
    keyPath: draft.value.keyPath,
  })) as SshAnswer | null
  adding.value = false
  if (!answer) return
  if (!answer.ok) {
    error.value = answer.error ?? '添加失败'
    return
  }
  draft.value = { name: '', host: '', port: '22', user: '', keyPath: '' }
  notice.value = '已添加。下一步读取并确认服务器指纹。'
  await load()
}

async function probe(host: SshHost) {
  probing.value = { ...probing.value, [host.id]: true }
  error.value = ''
  const answer = (await call('/api/ssh', { action: 'probe', host: host.host, port: host.port })) as SshAnswer | null
  probing.value = { ...probing.value, [host.id]: false }
  if (!answer) return
  if (!answer.ok) {
    error.value = answer.error ?? '读取指纹失败'
    return
  }
  proposals.value = {
    ...proposals.value,
    [host.id]: { fingerprint: answer.fingerprint ?? '', line: answer.line ?? '', keyType: answer.keyType ?? '' },
  }
}

async function confirmHost(host: SshHost) {
  const proposal = proposals.value[host.id]
  if (!proposal) return
  const answer = (await call('/api/ssh', { action: 'confirm', id: host.id, line: proposal.line, fingerprint: proposal.fingerprint })) as SshAnswer | null
  if (!answer?.ok) {
    error.value = answer?.error ?? '保存指纹失败'
    return
  }
  proposals.value = { ...proposals.value, [host.id]: null }
  notice.value = '指纹已保存。之后连接会按这个指纹校验，换了密钥就会被拒绝。'
  await load()
}

async function remove(host: SshHost) {
  if (removeArmed.value !== host.id) {
    removeArmed.value = host.id
    error.value = `再点一次「删除」会移除主机 ${host.name} 及其指纹记录`
    return
  }
  removeArmed.value = null
  const answer = (await call('/api/ssh', { action: 'remove', id: host.id })) as SshAnswer | null
  if (answer?.ok) {
    if (activeId.value === host.id) activeId.value = null
    await load()
  } else {
    error.value = answer?.error ?? '删除失败'
  }
}

async function run() {
  if (!activeHost.value) return
  running.value = true
  output.value = ''
  commandError.value = ''
  const answer = (await call('/api/ssh', { action: 'exec', id: activeHost.value.id, command: command.value })) as SshAnswer | null
  running.value = false
  if (!answer) return
  if (!answer.ok) commandError.value = answer.error ?? '执行失败'
  output.value = answer.output ?? ''
}

onMounted(load)
</script>

<template>
  <ShellDialog title="远程运维" meta="SSH · 首次连接需确认指纹" :width="900" @close="emit('close')">
    <p v-if="status && !status.available" class="rm__warn">
      本机没有可用的 OpenSSH 客户端。{{ status.hint }}
    </p>
    <p v-else-if="status" class="rm__muted">
      {{ status.version }}<template v-if="!status.keyscanAvailable"> · 缺少 ssh-keyscan，无法在连接前读取指纹</template>
    </p>

    <p v-if="error" class="rm__error">{{ error }}</p>
    <p v-if="notice" class="rm__muted">{{ notice }}</p>

    <div class="rm__grid">
      <section class="rm__hosts">
        <div v-for="host in hosts" :key="host.id" class="rm__card" :class="{ 'rm__card--active': host.id === activeId }">
          <button class="rm__pick" type="button" @click="activeId = host.id">
            <span class="rm__name">{{ host.name }}</span>
            <code class="rm__target">{{ host.user }}@{{ host.host }}:{{ host.port }}</code>
            <span class="rm__trust" :class="host.fingerprint ? 'rm__trust--ok' : 'rm__trust--no'">
              {{ host.fingerprint ? '指纹已确认' : '指纹未确认' }}
            </span>
          </button>

          <p v-if="host.fingerprint" class="rm__fp">{{ host.fingerprint }}</p>
          <template v-else>
            <button class="rm__btn" type="button" :disabled="probing[host.id]" @click="probe(host)">
              {{ probing[host.id] ? '读取中…' : '读取指纹' }}
            </button>
            <div v-if="proposals[host.id]" class="rm__proposal">
              <p class="rm__fp">{{ proposals[host.id]?.fingerprint }}（{{ proposals[host.id]?.keyType }}）</p>
              <p class="rm__hint">请与服务器管理员核对这段指纹；一致才点确认。</p>
              <button class="rm__btn rm__btn--primary" type="button" @click="confirmHost(host)">确认并保存</button>
            </div>
          </template>

          <button class="rm__btn rm__btn--danger" type="button" @click="remove(host)">
            {{ removeArmed === host.id ? '再点一次删除' : '删除主机' }}
          </button>
        </div>

        <p v-if="hosts.length === 0" class="rm__muted">还没有主机。填写下面的信息添加第一台。</p>

        <div class="rm__form">
          <input v-model="draft.name" class="rm__input" placeholder="备注名（可选）" spellcheck="false" />
          <input v-model="draft.host" class="rm__input" placeholder="主机 / IP" spellcheck="false" />
          <input v-model="draft.port" class="rm__input rm__input--short" placeholder="端口" spellcheck="false" />
          <input v-model="draft.user" class="rm__input" placeholder="用户名" spellcheck="false" />
          <input v-model="draft.keyPath" class="rm__input" placeholder="私钥路径（可留空，用 ssh-agent）" spellcheck="false" />
          <button class="rm__btn rm__btn--primary" type="button" :disabled="adding" @click="addHost">添加主机</button>
        </div>
      </section>

      <section class="rm__term">
        <p class="rm__muted">
          <template v-if="activeHost">
            目标：{{ activeHost.user }}@{{ activeHost.host }}:{{ activeHost.port }}
            <template v-if="!activeHost.fingerprint"> · 指纹未确认，执行会被拒绝</template>
          </template>
          <template v-else>先在左侧选一台主机</template>
        </p>
        <textarea v-model="command" class="rm__cmd" rows="3" spellcheck="false" placeholder="远程命令，例如 uptime 或 cat -- /etc/os-release" />
        <button class="rm__btn rm__btn--primary" type="button" :disabled="running || !activeHost || !activeHost.fingerprint" @click="run">
          {{ running ? '执行中…' : '执行' }}
        </button>
        <p v-if="commandError" class="rm__error">{{ commandError }}</p>
        <pre v-if="output" class="rm__output">{{ output }}</pre>
        <p v-if="trustable.length === 0 && hosts.length > 0" class="rm__hint">只有确认过指纹的主机才能执行命令。</p>
      </section>
    </div>
  </ShellDialog>
</template>

<style scoped>
.rm__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 14px;
  max-height: 64vh;
}

@media (max-width: 760px) {
  .rm__grid {
    grid-template-columns: 1fr;
  }
}

.rm__hosts,
.rm__term {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
}

.rm__card {
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.rm__card--active {
  border-color: var(--dsw-alias-label-tertiary);
}

.rm__pick {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
}

.rm__name {
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.rm__target,
.rm__fp {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  word-break: break-all;
}

.rm__fp {
  margin: 6px 0;
}

.rm__trust {
  font-size: 11px;
}

.rm__trust--ok {
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary));
}

.rm__trust--no {
  color: var(--dsw-alias-state-warn-secondary, var(--dsw-alias-label-secondary));
}

.rm__proposal {
  margin: 6px 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

.rm__form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.rm__input,
.rm__cmd {
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}

.rm__cmd {
  font-family: var(--dsw-font-family-code);
  resize: vertical;
}

.rm__input--short {
  max-width: 90px;
}

.rm__btn {
  align-self: flex-start;
  padding: 3px 9px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.rm__btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.rm__btn:disabled {
  opacity: 0.5;
}

.rm__btn--primary {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.rm__btn--danger {
  color: var(--dsw-alias-state-error-primary);
}

.rm__output {
  min-height: 120px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  white-space: pre-wrap;
}

.rm__muted {
  margin: 2px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.rm__hint {
  margin: 2px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

.rm__error {
  margin: 4px 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.rm__warn {
  margin: 4px 0 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
</style>
