<script setup lang="ts">
/**
 * 办公工具 — 模型能不能真的写 Word / Excel，以及为什么。
 *
 * WHY THIS WINDOW EXISTS AT ALL: these tools are not buttons. They run inside an MCP process that the
 * CLI starts, so the only honest UI is a status page: which tools were declared, which config file the
 * CLI was handed, and what to type in the conversation to use them. A "创建文档" button here would be a
 * second, divergent path to the same capability.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface OfficeTool {
  name: string
  summary: string
}

interface OfficeStatus {
  ok: boolean
  enabled: boolean
  configPath: string | null
  configError: string | null
  server: { name: string; command: string; args: string[] } | null
  tools: OfficeTool[]
  hint: string
  error?: string
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
const status = ref<OfficeStatus | null>(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/office`)
    const answer = (await response.json()) as OfficeStatus
    if (!answer.ok) error.value = answer.error ?? '读取办公工具状态失败'
    status.value = answer
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <ShellDialog title="办公工具" meta="模型通过 MCP 调用" :width="760" @close="emit('close')">
    <p v-if="loading" class="of__muted">正在读取…</p>
    <p v-else-if="error" class="of__error">{{ error }}</p>

    <template v-else-if="status">
      <div class="of__state" :class="status.enabled ? 'of__state--on' : 'of__state--off'">
        {{ status.enabled ? '已启用：claude.exe 每次启动都会加载这 6 个工具' : '未启用：这个安装没有可用的 MCP 配置' }}
      </div>

      <p class="of__hint">{{ status.hint }}</p>
      <p v-if="status.configError" class="of__error">{{ status.configError }}</p>

      <div v-if="status.server" class="of__server">
        <span class="of__label">MCP 配置</span>
        <code class="of__path" :title="status.configPath ?? ''">{{ status.configPath }}</code>
      </div>

      <table class="of__tools">
        <thead>
          <tr>
            <th>工具</th>
            <th>作用</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tool in status.tools" :key="tool.name">
            <td><code>{{ tool.name }}</code></td>
            <td>{{ tool.summary }}</td>
          </tr>
        </tbody>
      </table>

      <div class="of__notes">
        <p>· 文件只能写进当前会话的工作区，越界的路径会被拒绝；</p>
        <p>· 同名文件默认不覆盖，要覆盖得让模型带 <code>overwrite: true</code>；</p>
        <p>· 工具没出现时，先在「运行日志」里确认会话的 <code>mcp_servers</code> 有没有这项，再回来看这个页面的配置路径。</p>
      </div>
    </template>
  </ShellDialog>
</template>

<style scoped>
.of__muted {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
}

.of__error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px;
}

.of__state {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12.5px;
}

.of__state--on {
  background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.of__state--off {
  background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
}

.of__hint {
  margin: 8px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.7;
}

.of__server {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 10px;
}

.of__label {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.of__path {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.of__tools {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.of__tools th,
.of__tools td {
  padding: 5px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  text-align: left;
  vertical-align: top;
}

.of__tools th {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 500;
}

.of__tools td {
  color: var(--dsw-alias-label-secondary);
}

.of__tools code {
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.of__notes {
  margin-top: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.7;
}

.of__notes p {
  margin: 2px 0;
}
</style>
