<script setup lang="ts">
/**
 * 网页搜索（modsearch）：一次搜索，结果只回标题、链接与摘要。
 *
 * WHY NO INLINE PREVIEW: fetching arbitrary result pages turns this panel into a browser with the
 * bridge's network identity. Copying the link is enough, and the model can read the page itself when
 * the user asks a follow-up.
 */
import { ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

const emit = defineEmits<{ close: [] }>()

function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

interface Hit {
  title: string
  url: string
  snippet: string
}

const query = ref('')
const busy = ref(false)
const errorText = ref('')
const results = ref<Hit[]>([])
const notice = ref('')

async function run() {
  const text = query.value.trim()
  if (text === '') return
  busy.value = true
  errorText.value = ''
  notice.value = ''
  results.value = []
  try {
    const response = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(text)}&limit=8`)
    const answer = (await response.json()) as { ok: boolean; results?: Hit[]; error?: string }
    if (!answer.ok) errorText.value = answer.error ?? '搜索失败'
    else results.value = answer.results ?? []
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    busy.value = false
  }
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    notice.value = '链接已复制'
  } catch {
    notice.value = '复制失败：剪贴板不可用'
  }
}
</script>

<template>
  <ShellDialog title="网页搜索" meta="DuckDuckGo · 免费接口" :width="760" @close="emit('close')">
    <div class="se__row">
      <input
        v-model="query"
        class="se__input"
        placeholder="输入关键词，回车搜索"
        @keydown.enter.prevent="run"
      />
      <button class="se__btn" type="button" :disabled="busy || query.trim() === ''" @click="run">
        {{ busy ? '搜索中…' : '搜索' }}
      </button>
    </div>

    <p class="se__hint">
      结果来自 DuckDuckGo 的 HTML 接口，不需要 Key。它有限流：出现验证页时换一个词或稍后再试，
      这一点会如实报错，不会假装「没有结果」。
    </p>

    <p v-if="errorText" class="se__error">{{ errorText }}</p>
    <p v-if="notice" class="se__ok">{{ notice }}</p>

    <ol v-if="results.length > 0" class="se__list">
      <li v-for="hit in results" :key="hit.url" class="se__hit">
        <span class="se__title">{{ hit.title }}</span>
        <code class="se__url">{{ hit.url }}</code>
        <p v-if="hit.snippet" class="se__snippet">{{ hit.snippet }}</p>
        <button class="se__link" type="button" @click="copy(hit.url)">复制链接</button>
      </li>
    </ol>
  </ShellDialog>
</template>

<style scoped>
.se__row {
  display: flex;
  gap: 8px;
}

.se__input {
  flex: 1;
  padding: 8px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.se__btn {
  padding: 8px 16px;
  border: 0;
  border-radius: 8px;
  background: #ee8f3d;
  color: #2b1602;
  font-size: 13px;
  font-weight: 600;
}

.se__btn:disabled {
  opacity: 0.5;
}

.se__hint,
.se__snippet {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.7;
}

.se__list {
  margin: 12px 0 0;
  padding-left: 18px;
}

.se__hit {
  margin-bottom: 14px;
}

.se__title {
  display: block;
  font-size: 13px;
  font-weight: 500;
}

.se__url {
  display: block;
  margin: 2px 0 4px;
  color: #ffc38a;
  font-size: 11px;
  word-break: break-all;
}

.se__link {
  margin-top: 4px;
  padding: 2px 10px;
  border: 1px solid rgba(246, 165, 92, 0.55);
  border-radius: 999px;
  background: rgba(246, 165, 92, 0.16);
  color: #ffc38a;
  font-size: 11.5px;
}

.se__error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px;
}

.se__ok {
  color: #3ecf8e;
  font-size: 12px;
}
</style>
