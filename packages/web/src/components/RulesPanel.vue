<script setup lang="ts">
/**
 * 规则引擎 — rules that label a prompt, add a sentence to it, or refuse it.
 *
 * WHY THE PANEL SHOWS THE MATCH SUMMARY AS CODE: a rule's behaviour is entirely decided by its match
 * expression, and 关键字 / 正则 are the two things users get wrong. Showing `关键字 删除|rm -rf` and
 * `/abc[0-9]+/i` as the row's subtitle makes the difference visible without opening the editor.
 *
 * WHY THE TEST BOX TESTS THE SAVED RULES, NOT THE FORM: the bridge is the only thing that compiles a
 * pattern and the only thing that knows the stored workspace paths, so testing the draft here would
 * mean a second, weaker matcher in the page — exactly the kind of divergence that makes a rule fire in
 * the panel and not in the prompt. The hint under the box says so, and a bad pattern is refused at save
 * time with the bridge's own Chinese sentence shown inline.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

/** A stored rule — mirrors the shape `bridge/rules.mjs` accepts and returns. */
interface Rule {
  id: string
  name: string
  enabled: boolean
  match: { type: 'keyword' | 'regex'; value: string; ignoreCase?: boolean }
  scope: 'global' | 'workspace'
  cwd?: string
  action: 'label' | 'append' | 'block'
  label: string
  append: string
  note: string
}

interface RuleAnswer {
  ok: boolean
  error?: string
  file?: string
  rules?: Rule[]
}

interface Hit {
  id: string
  name: string
  label: string
  action: string
  append: string
  matched: string
}

interface TestAnswer {
  ok: boolean
  error?: string
  hits?: Hit[]
}

const emit = defineEmits<{ (e: 'close'): void }>()

const ACTION_LABEL: Record<string, string> = { label: '标签', append: '追加', block: '拦截' }

/**
 * The bridge client, kept local on purpose.
 *
 * Base-URL resolution follows `useBridge` / `useShellApi` character for character — injected shell
 * value, then `?bridge=`, then the dev proxy (empty, because vite proxies `/api`). This window opens
 * with no session attached, so it must not depend on the session composable to reach the bridge.
 */
function baseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

/**
 * One request. A non-2xx status is an error; `ok: false` inside a 200 body is not — the bridge reports
 * an invalid regex and a missing workspace as data with a Chinese sentence, and that sentence is what
 * the form has to display.
 */
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

const rules = ref<Rule[]>([])
const storePath = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const tab = ref<'rules' | 'test'>('rules')

/**
 * The editor. One flat object rather than a `Rule`, because every field is a string while the user is
 * typing: an empty `id` is what marks "this is a new rule".
 */
const draft = ref({
  id: '',
  name: '',
  enabled: true,
  type: 'keyword',
  value: '',
  ignoreCase: true,
  scope: 'global',
  cwd: '',
  action: 'label',
  label: '',
  append: '',
  note: '',
})

const testText = ref('')
const testCwd = ref('')
const hits = ref<Hit[]>([])
const tested = ref(false)

function report(problem: unknown) {
  error.value = problem instanceof Error ? problem.message : String(problem)
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const answer = await call<RuleAnswer>('/api/rules')
    if (!answer.ok) {
      error.value = answer.error ?? '读取失败'
      return
    }
    rules.value = answer.rules ?? []
    storePath.value = answer.file ?? ''
  } catch (problem) {
    report(problem)
  } finally {
    loading.value = false
  }
}

/** The form as the bridge's Rule shape, narrowing each select back to its union. */
function payload(): Rule {
  const type = draft.value.type === 'regex' ? 'regex' : 'keyword'
  const scope = draft.value.scope === 'workspace' ? 'workspace' : 'global'
  const action =
    draft.value.action === 'append' ? 'append' : draft.value.action === 'block' ? 'block' : 'label'
  return {
    id: draft.value.id,
    name: draft.value.name.trim(),
    enabled: draft.value.enabled,
    match: { type, value: draft.value.value.trim(), ignoreCase: draft.value.ignoreCase },
    scope,
    cwd: scope === 'workspace' ? draft.value.cwd.trim() : '',
    action,
    label: draft.value.label.trim(),
    append: draft.value.append.trim(),
    note: draft.value.note.trim(),
  }
}

function reset() {
  draft.value = {
    id: '',
    name: '',
    enabled: true,
    type: 'keyword',
    value: '',
    ignoreCase: true,
    scope: 'global',
    cwd: '',
    action: 'label',
    label: '',
    append: '',
    note: '',
  }
}

function edit(rule: Rule) {
  draft.value = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    type: rule.match.type === 'regex' ? 'regex' : 'keyword',
    value: rule.match.value,
    ignoreCase: rule.match.ignoreCase !== false,
    scope: rule.scope === 'workspace' ? 'workspace' : 'global',
    cwd: rule.cwd ?? '',
    action: rule.action === 'append' ? 'append' : rule.action === 'block' ? 'block' : 'label',
    label: rule.label,
    append: rule.append,
    note: rule.note,
  }
  error.value = null
  notice.value = null
  tab.value = 'rules'
}

async function save() {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<RuleAnswer>('/api/rules', { action: 'save', rule: payload() })
    if (!answer.ok) {
      // The draft is deliberately left as typed: the error names the field the user has to fix, and
      // clearing the form on a rejected regex would throw the pattern away with it.
      error.value = answer.error ?? '保存失败'
      return
    }
    rules.value = answer.rules ?? []
    reset()
    notice.value = '已保存'
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

/** Enabling/disabling is a save like any other, so the list and the store cannot drift apart. */
async function toggle(rule: Rule) {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<RuleAnswer>('/api/rules', {
      action: 'save',
      rule: { ...rule, enabled: !rule.enabled },
    })
    if (!answer.ok) {
      error.value = answer.error ?? '保存失败'
      return
    }
    rules.value = answer.rules ?? []
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

async function remove(rule: Rule) {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<RuleAnswer>('/api/rules', { action: 'delete', id: rule.id })
    if (!answer.ok) {
      error.value = answer.error ?? '删除失败'
      return
    }
    rules.value = answer.rules ?? []
    if (draft.value.id === rule.id) reset()
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

async function runTest() {
  busy.value = true
  error.value = null
  try {
    const answer = await call<TestAnswer>('/api/rules', {
      action: 'test',
      text: testText.value,
      cwd: testCwd.value.trim(),
    })
    if (!answer.ok) {
      error.value = answer.error ?? '测试失败'
      hits.value = []
      return
    }
    hits.value = answer.hits ?? []
    tested.value = true
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

/** `关键字 删除|rm -rf` or `/abc[0-9]+/i`, read off the rule itself rather than re-described. */
function matchSummary(rule: Rule): string {
  if (rule.match.type === 'regex') {
    return `/${rule.match.value}/${rule.match.ignoreCase === false ? '' : 'i'}`
  }
  return rule.match.value
}

onMounted(() => void load())
</script>

<template>
  <ShellDialog
    title="规则引擎"
    :meta="`${rules.length} 条规则 · 存在本机数据目录，不写进项目`"
    :width="820"
    @close="emit('close')"
  >
    <template #actions>
      <span v-if="loading" class="spinner" />
    </template>

    <p class="rp__lead">
      把「遇到这种情况就这样做」写成规则。命中后可以只标注、把一句话补进这一轮提示词，或者拦下来不让发 ——
      拦截只做上报，最终发不发由发送方决定。
    </p>

    <div class="tabs rp__tabs">
      <button class="tab" :class="{ 'tab--active': tab === 'rules' }" type="button" @click="tab = 'rules'">
        规则 ({{ rules.length }})
      </button>
      <button class="tab" :class="{ 'tab--active': tab === 'test' }" type="button" @click="tab = 'test'">
        测试
      </button>
    </div>

    <div v-if="error" class="rp__error">{{ error }}</div>
    <div v-else-if="notice" class="rp__notice">{{ notice }}</div>

    <template v-if="tab === 'rules'">
      <div class="rp__listHead">
        <span>规则列表</span>
        <span class="rp__spacer" />
        <button class="btnGhost rp__small" type="button" @click="reset">新建规则</button>
      </div>

      <div v-if="loading && rules.length === 0" class="rp__empty">
        <span class="spinner" />
        正在读取…
      </div>
      <div v-else-if="rules.length === 0" class="rp__empty">一条规则也没有：点「新建规则」加一条，或点「刷新」取回默认的三条。</div>
      <ul v-else class="rp__list">
        <li
          v-for="rule in rules"
          :key="rule.id"
          class="rp__item"
          :class="{ 'rp__item--off': !rule.enabled }"
        >
          <div class="rp__itemHead">
            <input
              type="checkbox"
              :checked="rule.enabled"
              :disabled="busy"
              :title="rule.enabled ? '已启用' : '已停用'"
              @change="toggle(rule)"
            />
            <span class="rp__name">{{ rule.name }}</span>
            <code class="rp__match" :class="`rp__match--${rule.match.type}`">{{ matchSummary(rule) }}</code>
            <span class="rp__badge" :class="`rp__badge--${rule.action}`">
              {{ ACTION_LABEL[rule.action] ?? rule.action }}
            </span>
            <span v-if="rule.scope === 'workspace'" class="rp__scope" :title="rule.cwd ?? ''">仅当前工作区</span>
            <span class="rp__spacer" />
            <button class="btnGhost rp__small" type="button" @click="edit(rule)">编辑</button>
            <button class="btnGhost rp__small" type="button" :disabled="busy" @click="remove(rule)">删除</button>
          </div>
          <p v-if="rule.label" class="rp__label">{{ rule.label }}</p>
          <p v-if="rule.append" class="rp__appendLine">追加：{{ rule.append }}</p>
          <p v-if="rule.note" class="rp__note">{{ rule.note }}</p>
        </li>
      </ul>

      <div class="rp__editor">
        <div class="rp__listHead">
          <span>{{ draft.id ? '编辑规则' : '新建规则' }}</span>
          <span class="rp__spacer" />
          <button v-if="draft.id" class="btnGhost rp__small" type="button" @click="reset">取消编辑</button>
        </div>

        <div class="rp__grid">
          <label class="rp__field rp__field--wide">
            <span class="rp__caption">名称</span>
            <input v-model="draft.name" class="rp__input" spellcheck="false" placeholder="例如：危险删除" />
          </label>
          <label class="rp__field">
            <span class="rp__caption">匹配方式</span>
            <select v-model="draft.type" class="rp__select">
              <option value="keyword">关键字</option>
              <option value="regex">正则</option>
            </select>
          </label>
          <label class="rp__field">
            <span class="rp__caption">动作</span>
            <select v-model="draft.action" class="rp__select">
              <option value="label">标签：只标注</option>
              <option value="append">追加：补进提示词</option>
              <option value="block">拦截：拒绝发送</option>
            </select>
          </label>
          <label class="rp__field rp__field--wide">
            <span class="rp__caption">匹配内容</span>
            <input
              v-model="draft.value"
              class="rp__input"
              spellcheck="false"
              :placeholder="
                draft.type === 'regex'
                  ? '(sk|ghp)-[A-Za-z0-9]{16,}'
                  : '删除|rm -rf（多个关键字用 | 分隔）'
              "
            />
          </label>
          <label class="rp__field">
            <span class="rp__caption">生效范围</span>
            <select v-model="draft.scope" class="rp__select">
              <option value="global">所有工作区</option>
              <option value="workspace">仅当前工作区</option>
            </select>
          </label>
          <label v-if="draft.scope === 'workspace'" class="rp__field rp__field--wide">
            <span class="rp__caption">工作区绝对路径</span>
            <input v-model="draft.cwd" class="rp__input" spellcheck="false" placeholder="D:\proj" />
          </label>
          <label class="rp__field rp__field--wide">
            <span class="rp__caption">标签文字</span>
            <input v-model="draft.label" class="rp__input" placeholder="命中时显示的一句话" />
          </label>
          <label class="rp__field rp__field--wide">
            <span class="rp__caption">追加内容</span>
            <textarea
              v-model="draft.append"
              class="rp__text"
              rows="2"
              placeholder="命中后补进提示词的句子（只有「追加」动作会用）"
            />
          </label>
          <label class="rp__field rp__field--wide">
            <span class="rp__caption">备注</span>
            <input v-model="draft.note" class="rp__input" placeholder="为什么加这条规则（可选）" />
          </label>
        </div>

        <div class="rp__row">
          <label class="rp__check">
            <input v-model="draft.enabled" type="checkbox" />
            启用
          </label>
          <label class="rp__check">
            <input v-model="draft.ignoreCase" type="checkbox" />
            忽略大小写
          </label>
          <span class="rp__spacer" />
          <button class="btnPrimary rp__save" type="button" :disabled="busy" @click="save">保存</button>
        </div>
      </div>
    </template>

    <template v-else>
      <p class="rp__hint">
        粘一段准备发出去的话，看看哪些规则会命中。测试读的是已保存的规则，刚改完的字段要先「保存」再测。
      </p>
      <textarea
        v-model="testText"
        class="rp__text rp__text--tall"
        rows="6"
        spellcheck="false"
        placeholder="粘贴提示词…"
      />
      <div class="rp__row">
        <input
          v-model="testCwd"
          class="rp__input rp__input--cwd"
          spellcheck="false"
          placeholder="工作区绝对路径（可选，只影响「仅当前工作区」的规则）"
        />
        <button class="btnPrimary rp__save" type="button" :disabled="busy || !testText.trim()" @click="runTest">
          测试
        </button>
      </div>

      <div v-if="hits.length === 0 && tested" class="rp__empty">没有规则命中。</div>
      <ul v-else-if="hits.length > 0" class="rp__hits">
        <li v-for="hit in hits" :key="hit.id" class="rp__hit">
          <div class="rp__itemHead">
            <span class="rp__name">{{ hit.name }}</span>
            <span class="rp__badge" :class="`rp__badge--${hit.action}`">
              {{ ACTION_LABEL[hit.action] ?? hit.action }}
            </span>
            <code class="rp__matched">{{ hit.matched || '（空匹配）' }}</code>
          </div>
          <p v-if="hit.label" class="rp__label">{{ hit.label }}</p>
          <p v-if="hit.append" class="rp__appendLine">追加：{{ hit.append }}</p>
          <p v-if="hit.action === 'block'" class="rp__blockLine">
            这是拦截规则：调用方应据此拒绝这次发送，或明确提示用户后再发。
          </p>
        </li>
      </ul>
    </template>

    <template #footer>
      <span v-if="storePath" class="rp__path" :title="storePath">{{ storePath }}</span>
      <span v-else class="rp__path">规则只存在本机，不写进项目目录。</span>
      <span class="rp__spacer" />
      <button class="btnGhost" type="button" :disabled="loading" @click="load">刷新</button>
    </template>
  </ShellDialog>
</template>

<style scoped>
.rp__lead {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.rp__tabs {
  margin-bottom: 12px;
}

.rp__error,
.rp__notice {
  margin-bottom: 12px;
  padding: 8px 11px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
}

.rp__error {
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.rp__notice {
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
}

.rp__listHead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.rp__spacer {
  flex: 1;
  min-width: 8px;
}

.rp__small {
  padding: 4px 10px;
  font-size: 11.5px;
}

.rp__list {
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}

.rp__item {
  padding: 9px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}

.rp__item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* A disabled rule stays readable: the point of switching one off is being able to switch it back on. */
.rp__item--off .rp__name,
.rp__item--off .rp__match,
.rp__item--off .rp__label {
  opacity: 0.5;
}

.rp__itemHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.rp__itemHead input[type='checkbox'] {
  flex: none;
}

.rp__name {
  font-size: 12.5px;
  font-weight: 600;
}

.rp__match,
.rp__matched {
  max-width: 260px;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp__match--regex {
  color: var(--dsw-alias-label-primary);
}

.rp__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  font-weight: 600;
}

.rp__badge--append {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.rp__badge--block {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.rp__scope {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.rp__label {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.rp__appendLine {
  margin: 4px 0 0;
  color: var(--dsw-alias-state-success-secondary);
  font-size: 11.5px;
  line-height: 18px;
}

.rp__blockLine {
  margin: 4px 0 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11.5px;
  line-height: 18px;
}

.rp__note {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
}

.rp__editor {
  margin-top: 16px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.rp__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.rp__field {
  display: flex;
  flex: 0 1 200px;
  flex-direction: column;
  gap: 4px;
}

.rp__field--wide {
  flex: 1 1 100%;
}

.rp__caption {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.rp__input,
.rp__select,
.rp__text {
  min-width: 0;
  padding: 7px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.rp__input:focus,
.rp__select:focus,
.rp__text:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.rp__text {
  width: 100%;
  resize: vertical;
  line-height: 18px;
}

.rp__text--tall {
  margin-bottom: 8px;
}

.rp__input--cwd {
  flex: 1;
}

.rp__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.rp__check {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
}

/* `.btnPrimary` is full-width by design (a dialog's confirm button); these sit in a row. */
.rp__save {
  flex: none;
  width: auto;
  height: 32px;
  margin: 0;
  padding: 0 16px;
}

.rp__hint {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 18px;
}

.rp__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 24px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.rp__hits {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.rp__hit {
  padding: 9px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}

.rp__hit + .rp__hit {
  margin-top: 8px;
}

.rp__path {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
