<script setup lang="ts">
/**
 * 评价与反馈 — writes the message where it cannot be lost, then hands the user the one click that
 * actually sends it.
 *
 * WHY THERE IS NO "已发送" UNTIL SOMETHING WAS SENT: this app has no server. A form that reports
 * success after a local write teaches the user that their feedback reached someone when it did not,
 * which is worse than no form at all. So the bridge stores the entry, returns a pre-filled `mailto:`
 * link, and the window says exactly which of the two happened.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import { formatAgo, shellGet, shellPost } from '../composables/useShellApi'

interface SavedEntry {
  at: number
  message: string
  email: string
}

const emit = defineEmits<{ (e: 'close'): void }>()

const message = ref('')
const email = ref('')
const busy = ref(false)
const status = ref('')
const tone = ref<'ok' | 'error' | ''>('')
const mailto = ref('')
const saved = ref<SavedEntry[]>([])

function say(text: string, next: 'ok' | 'error' | '') {
  status.value = text
  tone.value = next
}

async function loadSaved() {
  try {
    const answer = await shellGet<{ entries: SavedEntry[] }>('/api/feedback')
    saved.value = answer.entries
  } catch {
    // The saved list is a convenience; failing to read it must not block the form.
  }
}

async function send() {
  if (message.value.trim() === '') {
    say('请先填写评价与反馈内容', 'error')
    return
  }
  if (email.value.trim() === '') {
    say('请填写您的邮箱，否则作者无法回复您', 'error')
    return
  }

  busy.value = true
  say('正在保存…', '')
  try {
    const answer = await shellPost<{ ok: boolean; error?: string; mailto?: string; hint?: string }>('/api/feedback', {
      message: message.value,
      email: email.value,
    })
    if (!answer.ok) {
      say(answer.error ?? '保存失败', 'error')
      return
    }
    mailto.value = answer.mailto ?? ''
    say(answer.hint ?? '已保存到本机', 'ok')
    message.value = ''
    await loadSaved()
  } catch (problem) {
    say(`发送失败：${problem instanceof Error ? problem.message : String(problem)}`, 'error')
  } finally {
    busy.value = false
  }
}

function openMail() {
  if (mailto.value) window.location.href = mailto.value
}

onMounted(loadSaved)
</script>

<template>
  <ShellDialog title="评价与反馈" :width="620" @close="emit('close')">
    <p class="fb__intro">把您的使用感受、遇到的问题或想要的功能写在这里，直接发给作者本人。</p>

    <label class="fb__label" for="fb-message">评价与反馈（必填）</label>
    <textarea
      id="fb-message"
      v-model="message"
      class="fb__area"
      rows="7"
      spellcheck="false"
      placeholder="例如：轨迹视图里工具调用折叠后看不出改了哪个文件…"
    />

    <label class="fb__label" for="fb-email">您的邮箱（必填，用于回复）</label>
    <input id="fb-email" v-model="email" class="fb__input" spellcheck="false" placeholder="you@example.com" />
    <p class="fb__hint">邮箱只用于作者回复您，不会用于其他用途。</p>

    <div class="fb__send">
      <button class="btnPrimary" type="button" :disabled="busy" @click="send">
        {{ busy ? '正在保存…' : '发送' }}
      </button>
      <button v-if="mailto" class="btnGhost" type="button" @click="openMail">用邮件发送</button>
    </div>

    <p v-if="status" class="fb__status" :class="tone ? `fb__status--${tone}` : ''">{{ status }}</p>

    <section v-if="saved.length > 0" class="fb__saved">
      <h3 class="fb__h">本机已保存的反馈（{{ saved.length }}）</h3>
      <p class="fb__hint">
        保存在本机数据目录里，即使没发出去也不会丢；作者看到会尽快处理和联系，请勿短时间内重复发送。
      </p>
      <div v-for="entry in saved" :key="entry.at" class="fb__entry">
        <div class="fb__entryTop">
          <span>{{ formatAgo(entry.at) }}</span>
          <span class="fb__entryMail">{{ entry.email }}</span>
        </div>
        <p class="fb__entryText">{{ entry.message }}</p>
      </div>
    </section>
  </ShellDialog>
</template>

<style scoped>
.fb__intro {
  margin: 0 0 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
}

.fb__label {
  display: block;
  margin: 12px 0 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.fb__area,
.fb__input {
  width: 100%;
  padding: 9px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  line-height: 20px;
  resize: vertical;
}

.fb__area:focus,
.fb__input:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.fb__hint {
  margin: 7px 0 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 18px;
}

.fb__send {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.fb__status {
  margin: 12px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.fb__status--ok {
  color: var(--dsw-alias-state-success-secondary);
}

.fb__status--error {
  color: var(--dsw-alias-state-error-primary);
}

.fb__saved {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.fb__h {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
}

.fb__entry {
  margin-top: 10px;
  padding: 9px 11px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}

.fb__entryTop {
  display: flex;
  gap: 10px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.fb__entryMail {
  font-family: var(--dsw-font-family-code);
}

.fb__entryText {
  margin: 5px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
}
</style>
