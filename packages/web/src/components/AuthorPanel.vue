<script setup lang="ts">
/**
 * 作者信息 — the card behind the menu entry.
 *
 * The WeChat id is click-to-copy because it is eleven digits, which is exactly the length people get
 * wrong when retyping from a screenshot. The async clipboard API can be denied on a webview origin,
 * so the selection-based path is kept as a real fallback rather than a catch-and-shrug.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import { shellGet } from '../composables/useShellApi'

interface AuthorCard {
  name: string
  alias: string
  wechat: string
  email: string
  github: string
  gitee: string
  intro: string[]
  signoff: string
}

const emit = defineEmits<{ (e: 'close'): void }>()

const card = ref<AuthorCard | null>(null)
const error = ref<string | null>(null)
const hint = ref('点击微信号即可复制')

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    hint.value = `${label}已复制`
    return
  } catch {
    // Fall through to the selection path.
  }
  try {
    const scratch = document.createElement('textarea')
    scratch.value = text
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.append(scratch)
    scratch.select()
    const copied = document.execCommand('copy')
    scratch.remove()
    hint.value = copied ? `${label}已复制` : '复制失败，请手动输入上面的号码'
  } catch {
    hint.value = '复制失败，请手动输入上面的号码'
  }
}

onMounted(async () => {
  try {
    card.value = await shellGet<AuthorCard>('/api/shell/author')
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  }
})
</script>

<template>
  <ShellDialog title="作者信息" :width="640" @close="emit('close')">
    <div v-if="error" class="au__error">{{ error }}</div>
    <div v-else-if="!card" class="au__waiting"><span class="spinner" />正在读取…</div>

    <template v-else>
      <h2 class="au__name">{{ card.name }}</h2>
      <p v-for="(paragraph, index) in card.intro" :key="index" class="au__para">{{ paragraph }}</p>

      <h3 class="au__h">联系方式</h3>
      <p class="au__para">如果您对产品感兴趣，直接联系微信：</p>
      <button class="au__wechat" type="button" :title="hint" @click="copy(card.wechat, '微信号')">
        {{ card.wechat }}
      </button>
      <p class="au__hint">{{ hint }}</p>

      <div class="au__links">
        <button class="btnGhost" type="button" @click="copy(card.email, '邮箱')">复制邮箱 {{ card.email }}</button>
        <a class="btnGhost" :href="card.github" target="_blank" rel="noreferrer">GitHub</a>
        <a class="btnGhost" :href="card.gitee" target="_blank" rel="noreferrer">Gitee</a>
      </div>

      <p class="au__signoff">{{ card.signoff }}</p>
    </template>
  </ShellDialog>
</template>

<style scoped>
.au__waiting {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 24px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.au__error {
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.au__name {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}

.au__para {
  margin: 0 0 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 21px;
}

.au__h {
  margin: 16px 0 6px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
}

.au__wechat {
  padding: 8px 16px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 16px;
  letter-spacing: 1px;
}

.au__wechat:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.au__hint {
  margin: 8px 0 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.au__links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.au__links a {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}

.au__signoff {
  margin: 18px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
}
</style>
