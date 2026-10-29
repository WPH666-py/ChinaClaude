<script setup lang="ts">
/**
 * 代码管理 — status, diff, history and a commit box for the open workspace.
 *
 * WHY THE UNAVAILABLE STATE IS THE MOST IMPORTANT ONE HERE: on a machine without git (this build's
 * reference machine is one) an empty list looks exactly like a clean working tree. So the panel reports
 * the bridge's reason and install hint as its primary content, with a 重新检测 button, because a user who
 * installs git while this window is open should not have to restart the app to be believed.
 *
 * WHY THERE IS NO PUSH / PULL / RESET BUTTON: `bridge/gitpanel.mjs` deliberately implements none of them
 * — a GUI click is one slip away from rewriting shared history or discarding work, and nothing here can
 * undo that. The one write this panel performs is a commit of exactly the files it lists as 已暂存.
 *
 * The route contract: GET /api/git?cwd=…&what=available|status|log and POST /api/git with
 * { action: 'diff' | 'commit' }. No bridge instance is injected, so the base URL is resolved here the
 * same way `composables/useBridge.ts:50` does it.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface GitFile {
  path: string
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
  status: string
  from?: string | null
}

interface GitStatusAnswer {
  ok: boolean
  available?: boolean
  error?: string
  detail?: string | null
  reason?: string
  hint?: string | null
  branch?: string | null
  upstream?: string | null
  ahead?: number
  behind?: number
  detached?: boolean
  files?: GitFile[]
  truncated?: boolean
}

interface GitCommit {
  sha: string
  short: string
  author: string
  at: string
  subject: string
}

interface GitLogAnswer {
  ok: boolean
  error?: string
  commits?: GitCommit[]
  note?: string
}

interface GitDiffAnswer {
  ok: boolean
  error?: string
  patch?: string
  truncated?: boolean
  bytes?: number
  totalBytes?: number
}

interface GitCommitAnswer {
  ok: boolean
  error?: string
  output?: string
}

interface GitAvailableAnswer {
  ok: boolean
  available: boolean
  version?: string | null
  path?: string | null
  reason?: string | null
  hint?: string | null
  /** Present on the failure payload the bridge builds when it cannot even run a probe. */
  error?: string | null
}

const props = defineProps<{
  /** The workspace to inspect. Absent means no session is open yet. */
  cwd?: string | null
  /** 内嵌形态：由中间区的 Git 标签直接渲染，而不是弹窗。 */
  inline?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** Base URL resolution, mirrored from `composables/useBridge.ts:50`. See the module comment. */
function baseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

type Phase = 'checking' | 'unavailable' | 'ready'

const phase = ref<Phase>('checking')
const availability = ref<GitAvailableAnswer | null>(null)
const status = ref<GitStatusAnswer | null>(null)
const commits = ref<GitCommit[]>([])
const logNote = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const selected = ref<{ path: string; staged: boolean } | null>(null)
const patch = ref('')
const patchTruncated = ref(false)
const patchNote = ref('')
const diffBusy = ref(false)

const message = ref('')
const commitOutput = ref('')
const commitError = ref('')
const committing = ref(false)

/** Staging / branch / stash state. Kept beside the commit box: they are the same "write" surface. */
type BranchRow = { ref: string; name: string; upstream: string; current: boolean; remote: boolean }
type StashRow = { id: string; at: string; subject: string }
const branches = ref<BranchRow[]>([])
const branchPick = ref('')
const stashEntries = ref<StashRow[]>([])
const stashMessage = ref('')
const opBusy = ref(false)
const opError = ref('')
const opOutput = ref('')
/** Second-click guards, one per destructive action; a timer clears them so a stale one cannot fire. */
const discardArmed = ref<string | null>(null)
const dropArmed = ref<string | null>(null)
let armTimer = 0

function arm(target: 'discard' | 'drop', key: string) {
  if (target === 'discard') discardArmed.value = key
  else dropArmed.value = key
  window.clearTimeout(armTimer)
  armTimer = window.setTimeout(() => {
    discardArmed.value = null
    dropArmed.value = null
  }, 5000)
}

const stagedFiles = computed(() => (status.value?.files ?? []).filter((file) => file.staged))
/** Worktree-side changes, including a file that is staged AND edited further (`MM`) — git means both. */
const unstagedFiles = computed(
  () => (status.value?.files ?? []).filter((file) => !file.untracked && file.worktree !== ' '),
)
const untrackedFiles = computed(() => (status.value?.files ?? []).filter((file) => file.untracked))

const branchLine = computed(() => {
  const current = status.value
  if (!current?.branch) return current?.detached ? '游离 HEAD（不在任何分支上）' : '分支未知'
  const parts = [`分支 ${current.branch}`]
  if (current.upstream) parts.push(`上游 ${current.upstream}`)
  parts.push(`领先 ${current.ahead ?? 0}`)
  parts.push(`落后 ${current.behind ?? 0}`)
  return parts.join(' · ')
})

const canCommit = computed(
  () => message.value.trim() !== '' && stagedFiles.value.length > 0 && !committing.value,
)

function when(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function keyOf(file: GitFile, staged: boolean): string {
  return `${staged ? 'staged' : 'worktree'}:${file.path}`
}

function isSelected(file: GitFile, staged: boolean): boolean {
  return selected.value?.path === file.path && selected.value?.staged === staged
}

/** Both halves of the unavailable answer, so a missing binary never renders as an empty list. */
function reasonText(answer: GitStatusAnswer | GitAvailableAnswer | null): string {
  if (!answer) return '本机没有找到可用的 git'
  return answer.reason ?? answer.error ?? '本机没有找到可用的 git'
}

async function check() {
  phase.value = 'checking'
  error.value = null
  try {
    const response = await fetch(`${baseUrl()}/api/git?what=available`)
    const answer = (await response.json()) as GitAvailableAnswer
    availability.value = answer
    if (!answer.available) {
      phase.value = 'unavailable'
      return
    }
    phase.value = 'ready'
    await refresh()
  } catch (cause) {
    phase.value = 'unavailable'
    availability.value = null
    error.value = `检测 git 失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function refresh() {
  if (!props.cwd) return
  busy.value = true
  error.value = null
  logNote.value = ''
  try {
    const directory = encodeURIComponent(props.cwd)
    const [statusResponse, logResponse] = await Promise.all([
      fetch(`${baseUrl()}/api/git?cwd=${directory}&what=status`),
      fetch(`${baseUrl()}/api/git?cwd=${directory}&what=log&limit=30`),
    ])
    const statusAnswer = (await statusResponse.json()) as GitStatusAnswer
    const logAnswer = (await logResponse.json()) as GitLogAnswer

    // The status route reports availability too: git can disappear between the check and the read, and
    // that must flip the panel back to its install hint rather than print a bare error.
    if (statusAnswer.available === false) {
      availability.value = { ...statusAnswer, available: false }
      phase.value = 'unavailable'
      return
    }
    if (!statusAnswer.ok) {
      status.value = null
      error.value = statusAnswer.detail ? `${statusAnswer.error ?? '读取状态失败'}（${statusAnswer.detail}）` : (statusAnswer.error ?? '读取状态失败')
      return
    }
    status.value = statusAnswer
    commits.value = logAnswer.ok ? (logAnswer.commits ?? []) : []
    logNote.value = logAnswer.note ?? ''
    if (!logAnswer.ok && logAnswer.error) error.value = logAnswer.error

    // A selected file may be gone after a commit; dropping the pane is better than showing a stale patch.
    if (selected.value && !(statusAnswer.files ?? []).some((file) => file.path === selected.value?.path)) {
      selected.value = null
      patch.value = ''
    }
  } catch (cause) {
    error.value = `读取仓库失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}

async function openDiff(file: GitFile, staged: boolean) {
  if (!props.cwd) return
  selected.value = { path: file.path, staged }
  diffBusy.value = true
  patch.value = ''
  patchNote.value = ''
  patchTruncated.value = false
  try {
    const response = await fetch(`${baseUrl()}/api/git`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'diff', cwd: props.cwd, file: file.path, staged }),
    })
    const answer = (await response.json()) as GitDiffAnswer
    if (!answer.ok) {
      patchNote.value = answer.error ?? '读取差异失败'
      return
    }
    patch.value = answer.patch ?? ''
    patchTruncated.value = answer.truncated === true
    if (patch.value === '') {
      patchNote.value = file.untracked
        ? '未跟踪的文件没有差异 —— git 只对已跟踪的内容算 diff，先暂存它再看。'
        : '这个文件没有差异。'
    }
  } catch (cause) {
    patchNote.value = `读取差异失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    diffBusy.value = false
  }
}

async function commit() {
  if (!props.cwd || !canCommit.value) return
  committing.value = true
  commitOutput.value = ''
  commitError.value = ''
  try {
    const response = await fetch(`${baseUrl()}/api/git`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The file list is sent explicitly so the commit contains exactly what the 已暂存 group showed.
      body: JSON.stringify({
        action: 'commit',
        cwd: props.cwd,
        message: message.value,
        files: stagedFiles.value.map((file) => file.path),
      }),
    })
    const answer = (await response.json()) as GitCommitAnswer
    commitOutput.value = answer.output ?? ''
    if (!answer.ok) {
      commitError.value = answer.error ?? '提交失败'
      return
    }
    message.value = ''
    await refresh()
  } catch (cause) {
    commitError.value = `提交失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    committing.value = false
  }
}

/**
 * One write to the repository, with the shared busy/error plumbing every button below needs.
 *
 * WHY ERRORS ARE SHOWN VERBATIM: git's own refusal ("error: Your local changes would be overwritten")
 * names the file and the reason; replacing it with "操作失败" throws away the only actionable part.
 */
async function gitPost<T extends { ok: boolean; error?: string; output?: string }>(body: Record<string, unknown>): Promise<T | null> {
  opBusy.value = true
  opError.value = ''
  opOutput.value = ''
  try {
    const response = await fetch(`${baseUrl()}/api/git`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, cwd: props.cwd }),
    })
    const answer = (await response.json()) as T
    if (answer.output) opOutput.value = answer.output
    if (!answer.ok) opError.value = answer.error ?? '操作失败'
    return answer
  } catch (cause) {
    opError.value = `操作失败：${cause instanceof Error ? cause.message : String(cause)}`
    return null
  } finally {
    opBusy.value = false
  }
}

async function setStage(paths: string[], staged: boolean) {
  const answer = await gitPost({ action: staged ? 'unstage' : 'stage', files: paths })
  if (answer?.ok) await refresh()
}

async function stageAll() {
  const paths = [...unstagedFiles.value, ...untrackedFiles.value].map((file) => file.path)
  if (paths.length === 0) {
    opError.value = '没有要暂存的改动'
    return
  }
  await setStage(paths, false)
}

async function discardSelected() {
  if (!selected.value) return
  const key = selected.value.path
  if (discardArmed.value !== key) {
    arm('discard', key)
    opError.value = `再点一次「丢弃」将永久删除 ${key} 的未提交改动（不可恢复）`
    return
  }
  discardArmed.value = null
  const answer = await gitPost({ action: 'discard', path: key, confirm: true })
  if (answer?.ok) {
    selected.value = null
    patch.value = ''
    await refresh()
  }
}

async function loadBranches() {
  if (!props.cwd) return
  try {
    const response = await fetch(`${baseUrl()}/api/git?cwd=${encodeURIComponent(props.cwd)}&what=branches`)
    const answer = (await response.json()) as { ok: boolean; branches?: BranchRow[]; error?: string }
    branches.value = answer.ok ? answer.branches ?? [] : []
    const current = branches.value.find((entry) => entry.current)
    branchPick.value = current?.name ?? branchPick.value
    if (!answer.ok && answer.error) opError.value = answer.error
  } catch (cause) {
    opError.value = `读取分支失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function switchBranch() {
  if (branchPick.value === '') return
  const answer = await gitPost({ action: 'checkout', branch: branchPick.value })
  if (answer?.ok) {
    await refresh()
    await loadBranches()
  }
}

async function loadStash() {
  if (!props.cwd) return
  try {
    const response = await fetch(`${baseUrl()}/api/git?cwd=${encodeURIComponent(props.cwd)}&what=stash`)
    const answer = (await response.json()) as { ok: boolean; entries?: StashRow[]; error?: string }
    stashEntries.value = answer.ok ? answer.entries ?? [] : []
    if (!answer.ok && answer.error) opError.value = answer.error
  } catch (cause) {
    opError.value = `读取储藏失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function saveStash() {
  const answer = await gitPost({ action: 'stash-save', message: stashMessage.value })
  if (answer?.ok) {
    stashMessage.value = ''
    await loadStash()
    await refresh()
  }
}

async function useStash(entry: StashRow, action: 'apply' | 'pop' | 'drop') {
  const index = Number((entry.id.match(/\{(\d+)\}/) ?? [])[1])
  if (!Number.isInteger(index)) {
    opError.value = `无法识别储藏序号：${entry.id}`
    return
  }
  if (action === 'drop' && dropArmed.value !== entry.id) {
    arm('drop', entry.id)
    opError.value = `再点一次「删除」将永久丢弃 ${entry.id}（不可恢复）`
    return
  }
  dropArmed.value = null
  const answer = await gitPost({ action: `stash-${action}`, index, confirm: action === 'drop' })
  if (answer?.ok) {
    await loadStash()
    await refresh()
  }
}

onMounted(async () => {
  await check()
  if (phase.value === 'ready') {
    await loadBranches()
    await loadStash()
  }
})
/** Switching workspace is a different repository; nothing shown before the switch still applies. */
watch(
  () => props.cwd,
  async () => {
    status.value = null
    commits.value = []
    selected.value = null
    patch.value = ''
    commitOutput.value = ''
    commitError.value = ''
    branches.value = []
    stashEntries.value = []
    opError.value = ''
    opOutput.value = ''
    if (phase.value === 'ready') {
      await refresh()
      await loadBranches()
      await loadStash()
    }
  },
)
</script>

<template>
  <ShellDialog title="代码管理" :meta="cwd ?? ''" :width="880" :inline="inline" @close="emit('close')">
    <!-- git is genuinely absent: say so, with the one thing that fixes it. -->
    <div v-if="phase === 'unavailable'" class="gp__missing">
      <div class="gp__missingTitle">本机没有可用的 git</div>
      <p class="gp__missingReason">{{ reasonText(availability ?? status) }}</p>
      <p v-if="availability?.hint" class="gp__missingHint">{{ availability.hint }}</p>
      <p v-if="error" class="gp__missingReason">{{ error }}</p>
      <button class="btnGhost" type="button" :disabled="busy" @click="check">重新检测</button>
    </div>

    <template v-else>
      <div v-if="!cwd" class="gp__empty">
        还没有打开工作目录。先在左侧选择一个项目，代码管理会显示它的状态、差异与提交历史。
      </div>

      <template v-else>
        <div class="gp__bar">
          <span class="gp__branch">{{ branchLine }}</span>
          <span v-if="availability?.version" class="gp__version">· {{ availability.version }}</span>
          <span class="gp__spacer" />
          <span v-if="busy" class="spinner" />
          <button class="btnGhost" type="button" :disabled="busy" @click="refresh">刷新</button>
        </div>

        <div v-if="error" class="banner banner--error">{{ error }}</div>
        <div v-if="status?.truncated" class="banner banner--info">
          改动列表过长，只显示了一部分。
        </div>

        <div v-if="opError" class="banner banner--error">{{ opError }}</div>
        <pre v-if="opOutput" class="gp__output">{{ opOutput }}</pre>

        <!-- staging + branch -->
        <div class="gp__ops">
          <button class="btnGhost" type="button" :disabled="opBusy" @click="stageAll">全部暂存</button>
          <span class="gp__spacer" />
          <select v-model="branchPick" class="gp__select" :disabled="opBusy || branches.length === 0">
            <option v-for="entry in branches" :key="entry.ref" :value="entry.name">
              {{ entry.current ? '● ' : '' }}{{ entry.name }}{{ entry.remote ? '（远程）' : '' }}
            </option>
          </select>
          <button class="btnGhost" type="button" :disabled="opBusy || branchPick === ''" @click="switchBranch">切换分支</button>
        </div>

        <div class="gp__groups">
          <div class="gp__group">
            <div class="gp__groupHead">已暂存 ({{ stagedFiles.length }})</div>
            <div v-if="stagedFiles.length === 0" class="gp__groupEmpty">没有已暂存的改动</div>
            <button
              v-for="file in stagedFiles"
              :key="keyOf(file, true)"
              class="gp__file"
              :class="{ 'gp__file--active': isSelected(file, true) }"
              type="button"
              :title="file.path"
              @click="openDiff(file, true)"
            >
              <span class="gp__badge gp__badge--staged">{{ file.status }}</span>
              <span class="gp__path">{{ file.path }}</span>
            </button>
          </div>

          <div class="gp__group">
            <div class="gp__groupHead">未暂存 ({{ unstagedFiles.length }})</div>
            <div v-if="unstagedFiles.length === 0" class="gp__groupEmpty">工作区没有未暂存的改动</div>
            <button
              v-for="file in unstagedFiles"
              :key="keyOf(file, false)"
              class="gp__file"
              :class="{ 'gp__file--active': isSelected(file, false) }"
              type="button"
              :title="file.path"
              @click="openDiff(file, false)"
            >
              <span class="gp__badge">{{ file.status }}</span>
              <span class="gp__path">{{ file.path }}</span>
            </button>
          </div>

          <div class="gp__group">
            <div class="gp__groupHead">未跟踪 ({{ untrackedFiles.length }})</div>
            <div v-if="untrackedFiles.length === 0" class="gp__groupEmpty">没有未跟踪的文件</div>
            <button
              v-for="file in untrackedFiles"
              :key="keyOf(file, false)"
              class="gp__file"
              :class="{ 'gp__file--active': isSelected(file, false) }"
              type="button"
              :title="file.path"
              @click="openDiff(file, false)"
            >
              <span class="gp__badge gp__badge--new">{{ file.status }}</span>
              <span class="gp__path">{{ file.path }}</span>
            </button>
          </div>
        </div>

        <!-- diff -->
        <div class="gp__section">
          差异
          <span v-if="selected" class="gp__sectionFile" :title="selected.path">
            {{ selected.staged ? '已暂存' : '未暂存' }} · {{ selected.path }}
          </span>
          <span v-if="diffBusy" class="spinner" />
        </div>
        <div v-if="patchTruncated" class="gp__warn">
          差异超过 200 KB，只显示了前面一段（后面的改动未显示）。
        </div>
        <pre v-if="patch" class="gp__diff">{{ patch }}</pre>
        <div v-else class="gp__diffEmpty">{{ patchNote || '点上面任意一个文件查看它的差异。' }}</div>

        <!-- actions for the selected file: staging is reversible, discarding is not -->
        <div v-if="selected" class="gp__fileOps">
          <span class="gp__fileOpsName" :title="selected.path">{{ selected.path }}</span>
          <button class="btnGhost" type="button" :disabled="opBusy" @click="setStage([selected.path], selected.staged)">
            {{ selected.staged ? '取消暂存' : '暂存' }}
          </button>
          <button class="btnGhost btnGhost--danger" type="button" :disabled="opBusy" @click="discardSelected">
            {{ discardArmed === selected.path ? '确认丢弃（不可恢复）' : '丢弃改动' }}
          </button>
        </div>

        <!-- commit -->
        <div class="gp__section">提交</div>
        <textarea
          v-model="message"
          class="gp__input"
          rows="3"
          spellcheck="false"
          placeholder="提交信息（必填）"
        />
        <div class="gp__commitRow">
          <button class="btnGhost" type="button" :disabled="!canCommit" @click="commit">
            {{ committing ? '提交中…' : '提交' }}
          </button>
          <span class="gp__commitHint">
            将提交「已暂存」里的 {{ stagedFiles.length }} 个文件；未暂存的改动不会被提交。
          </span>
        </div>
        <div v-if="commitError" class="banner banner--error">{{ commitError }}</div>
        <pre v-if="commitOutput" class="gp__output">{{ commitOutput }}</pre>

        <!-- stash -->
        <div class="gp__section">储藏</div>
        <div class="gp__ops">
          <input v-model="stashMessage" class="gp__input gp__stashInput" placeholder="储藏备注（可选）" spellcheck="false" />
          <button class="btnGhost" type="button" :disabled="opBusy" @click="saveStash">保存当前改动</button>
        </div>
        <div v-if="stashEntries.length === 0" class="gp__groupEmpty">没有储藏记录</div>
        <div v-for="entry in stashEntries" :key="entry.id" class="gp__stashRow">
          <code class="gp__sha">{{ entry.id }}</code>
          <span class="gp__subject" :title="entry.subject">{{ entry.subject }}</span>
          <span class="gp__time">{{ when(entry.at) }}</span>
          <button class="btnGhost" type="button" :disabled="opBusy" @click="useStash(entry, 'apply')">应用</button>
          <button class="btnGhost" type="button" :disabled="opBusy" @click="useStash(entry, 'pop')">弹出</button>
          <button class="btnGhost btnGhost--danger" type="button" :disabled="opBusy" @click="useStash(entry, 'drop')">
            {{ dropArmed === entry.id ? '确认删除' : '删除' }}
          </button>
        </div>

        <!-- history -->
        <div class="gp__section">最近提交</div>
        <div class="gp__commits">
          <div v-if="commits.length === 0" class="gp__groupEmpty">
            {{ logNote || '没有提交记录' }}
          </div>
          <div v-for="entry in commits" :key="entry.sha" class="gp__commit">
            <code class="gp__sha">{{ entry.short }}</code>
            <span class="gp__subject" :title="entry.subject">{{ entry.subject }}</span>
            <span class="gp__author">{{ entry.author }}</span>
            <span class="gp__time">{{ when(entry.at) }}</span>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <button class="btnGhost" type="button" :disabled="busy || !cwd || phase !== 'ready'" @click="refresh">
        刷新
      </button>
      <span class="gp__spacer" />
      <span class="gp__footNote">支持状态 / 差异 / 暂存 / 提交 / 分支切换 / 储藏；推送与拉取请用终端（模块刻意不实现）。</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.gp__missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.gp__missingTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 600;
}

.gp__missingReason {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.gp__missingHint {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 12px;
  line-height: 18px;
}

.gp__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.gp__branch {
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.gp__version {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gp__spacer {
  flex: 1;
}

.gp__groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.gp__group {
  min-width: 0;
  max-height: 180px;
  padding: 6px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  overflow-y: auto;
}

.gp__groupHead {
  padding: 2px 4px 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 600;
}

.gp__groupEmpty {
  padding: 8px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 16px;
}

.gp__file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}

.gp__file:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.gp__file--active {
  background: var(--dsw-alias-interactive-bg-hover);
}

.gp__badge {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 10px;
  font-weight: 600;
}

.gp__badge--staged {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.gp__badge--new {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
}

.gp__path {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gp__section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
}

.gp__sectionFile {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gp__warn {
  margin-bottom: 6px;
  padding: 6px 9px;
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 11.5px;
}

.gp__diff {
  height: 260px;
  margin: 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 17px;
  white-space: pre;
}

.gp__diffEmpty {
  padding: 22px 8px;
  border: 0.5px dashed var(--dsw-alias-border-l1);
  border-radius: 8px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
  text-align: center;
}

.gp__input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  line-height: 18px;
  resize: vertical;
}

.gp__input:focus {
  border-color: var(--dsw-alias-border-l3);
}

.gp__commitRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.gp__commitHint {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.gp__output {
  max-height: 90px;
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow: auto;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
}

.gp__commits {
  max-height: 170px;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  overflow-y: auto;
}

.gp__commit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.gp__commit:last-child {
  border-bottom: none;
}

.gp__sha {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.gp__subject {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gp__author {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.gp__time {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.gp__empty {
  padding: 40px 12px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
  line-height: 19px;
  text-align: center;
}

.gp__footNote {
  color: var(--dsw-alias-label-caption);
}

/* Staging / branch / stash controls. One row of small controls above the groups, because they act on
   the whole working tree — the per-file actions live next to the diff they belong to. */
.gp__ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  flex-wrap: wrap;
}

.gp__select {
  max-width: 240px;
  padding: 3px 6px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.gp__fileOps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 2px;
  flex-wrap: wrap;
}

.gp__fileOpsName {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gp__stashInput {
  flex: 1;
  min-width: 160px;
}

.gp__stashRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 11.5px;
}

.gp__stashRow .gp__subject {
  min-width: 0;
  flex: 1;
}
</style>
