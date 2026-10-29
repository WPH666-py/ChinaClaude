<script setup lang="ts">
/**
 * 服务器管理：桥与运行时的当前状态。
 *
 * WHY A READ-ONLY PANEL: this app has no server to administer — the bridge is a child process of the
 * window, and "管理" here means "看清它现在是什么状态、出问题去哪里看日志". Buttons that restarted or
 * killed things would duplicate 重启 in the menu bar and add a second way to lose a running turn.
 */
import { computed, onMounted, ref } from 'vue'

import ShellDialog from './ShellDialog.vue'

const emit = defineEmits<{ close: [] }>()

/** Same three-step resolution every panel uses (shell injection → ?bridge= → dev proxy). */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

interface Health {
  ok: boolean
  version?: number
  appVersion?: string
  binary?: string
  baseUrl?: string
  hasCredential?: boolean
  sessions?: number
  error?: string
}

const health = ref<Health | null>(null)
const loading = ref(true)
const errorText = ref('')

const rows = computed(() => {
  const value = health.value
  if (!value) return []
  return [
    { label: '桥协议版本', value: String(value.version ?? '未知') },
    { label: '应用版本', value: value.appVersion ?? '未知' },
    { label: '桥地址', value: baseUrl },
    { label: '上游地址', value: value.baseUrl ?? '未配置' },
    { label: '凭据', value: value.hasCredential ? '已配置' : '未配置（API 密钥里填）' },
    { label: '活动会话', value: String(value.sessions ?? 0) },
  ]
})

async function load() {
  loading.value = true
  errorText.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/health`)
    health.value = (await response.json()) as Health
    if (!health.value.ok) errorText.value = health.value.error ?? '桥返回了失败状态'
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
    health.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <ShellDialog title="服务器管理" meta="桥状态 · 运行时" :width="640" @close="emit('close')">
    <p v-if="loading" class="sv__muted">正在读取桥状态…</p>
    <p v-else-if="errorText" class="sv__error">读不到桥：{{ errorText }}</p>

    <table v-else-if="health" class="sv__table">
      <tbody>
        <tr v-for="row in rows" :key="row.label">
          <th>{{ row.label }}</th>
          <td>{{ row.value }}</td>
        </tr>
      </tbody>
    </table>

    <p class="sv__hint">
      运行日志在「运行日志」里；重启在菜单栏「重启」。桥是随窗口启动的子进程，退出窗口即结束。
    </p>
  </ShellDialog>
</template>

<style scoped>
.sv__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.sv__table th,
.sv__table td {
  padding: 7px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  text-align: left;
  vertical-align: top;
}

.sv__table th {
  width: 30%;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.sv__table td {
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}

.sv__muted,
.sv__hint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.6;
}

.sv__error {
  font-size: 13px;
  color: var(--dsw-alias-state-error-primary);
}
</style>
