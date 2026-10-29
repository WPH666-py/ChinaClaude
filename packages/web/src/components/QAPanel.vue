<script setup lang="ts">
/**
 * 代码测试（qa-skills）：探测项目自带的测试命令，按一次跑一次。
 *
 * WHY THE COMMAND IS SHOWN BEFORE IT RUNS: a test runner that executes something the user cannot see
 * is a remote code execution prompt wearing a friendly label. The candidate list is the consent screen.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

const props = defineProps<{ cwd?: string | null }>()
const emit = defineEmits<{ close: [] }>()

function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

interface Candidate {
  id: string
  label: string
  command: string[]
  kind: string
}

const candidates = ref<Candidate[]>([])
const output = ref('')
const running = ref<string | null>(null)
const errorText = ref('')
const last = ref<{ ok: boolean; code?: number; ms?: number; timeout?: boolean } | null>(null)

async function load() {
  errorText.value = ''
  if (!props.cwd) {
    errorText.value = '需要先打开一个工作目录。'
    return
  }
  try {
    const response = await fetch(`${baseUrl}/api/qa?cwd=${encodeURIComponent(props.cwd)}`)
    const answer = (await response.json()) as { ok: boolean; candidates?: Candidate[]; error?: string }
    if (!answer.ok) errorText.value = answer.error ?? '探测失败'
    else candidates.value = answer.candidates ?? []
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  }
}

async function run(candidate: Candidate) {
  running.value = candidate.id
  output.value = ''
  last.value = null
  errorText.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/qa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: props.cwd, command: candidate.command }),
    })
    const answer = (await response.json()) as { ok: boolean; code?: number; output?: string; ms?: number; timeout?: boolean; error?: string }
    output.value = answer.output ?? ''
    last.value = { ok: answer.ok, code: answer.code, ms: answer.ms, timeout: answer.timeout }
    if (answer.error) errorText.value = answer.error
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    running.value = null
  }
}

onMounted(load)
</script>

<template>
  <ShellDialog title="代码测试" :meta="cwd ?? '未打开工作区'" :width="820" @close="emit('close')">
    <p class="qa__hint">
      只跑项目里已有的测试脚本：不安装依赖、不进入 watch 模式，单次最长 3 分钟。命令会先列出来，点了才执行。
    </p>

    <p v-if="errorText" class="qa__error">{{ errorText }}</p>

    <ul v-if="candidates.length > 0" class="qa__list">
      <li v-for="candidate in candidates" :key="candidate.id" class="qa__item">
        <code class="qa__cmd">{{ candidate.label }}</code>
        <span class="qa__kind">{{ candidate.kind }}</span>
        <button class="qa__btn" type="button" :disabled="running !== null" @click="run(candidate)">
          {{ running === candidate.id ? '运行中…' : '运行' }}
        </button>
      </li>
    </ul>
    <p v-else class="qa__hint">没有识别到可运行的测试：支持 package.json 的 test 脚本、pytest、go test、cargo test。</p>

    <div v-if="last" class="qa__status" :class="{ 'qa__status--ok': last.ok, 'qa__status--bad': !last.ok }">
      {{ last.ok ? '通过' : last.timeout ? '超时终止' : '失败' }}
      <span v-if="last.code !== undefined">· 退出码 {{ last.code }}</span>
      <span v-if="last.ms"> · 用时 {{ (last.ms / 1000).toFixed(1) }}s</span>
    </div>

    <pre v-if="output" class="qa__out">{{ output }}</pre>
  </ShellDialog>
</template>

<style scoped>
.qa__hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.7;
}

.qa__list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.qa__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.qa__cmd {
  flex: 1;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}

.qa__kind {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.qa__btn {
  padding: 4px 14px;
  border: 1px solid rgba(246, 165, 92, 0.55);
  border-radius: 999px;
  background: rgba(246, 165, 92, 0.16);
  color: #ffc38a;
  font-size: 12px;
}

.qa__btn:disabled {
  opacity: 0.5;
}

.qa__status {
  margin-top: 10px;
  font-size: 12.5px;
}

.qa__status--ok {
  color: #3ecf8e;
}

.qa__status--bad {
  color: var(--dsw-alias-state-error-primary);
}

.qa__out {
  margin-top: 8px;
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.qa__error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px;
}
</style>
