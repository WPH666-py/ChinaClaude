<script setup lang="ts">
/**
 * Security audit for a plugin or skill directory.
 *
 * Backed by the vendored `@jieai/dsh-plugin-vet` engine. Claude Code loads skills from
 * `<root>/.claude/skills/<name>/SKILL.md` and can load plugins; both are arbitrary third-party code
 * and, in the SKILL.md case, arbitrary INSTRUCTIONS. The engine has dedicated rules for exactly
 * that (R17 config injection, R18 instruction/skill injection), which is why this belongs in a
 * Claude Code client rather than being a generic linter.
 *
 * Two things this panel must never do:
 *   - show a score without saying which rule set produced it, because a verdict is only meaningful
 *     against a named engine version;
 *   - render "could not audit" and "audited clean" the same way. That distinction is the entire
 *     value of a pre-install check, so a failure is shown prominently and a truncated scan is
 *     labelled rather than presented as a clean bill of health.
 */
import { computed, onMounted, ref } from 'vue'
import type { Bridge } from '../composables/useBridge'
import type { VetFinding, VetReport, VetStatus } from '../types'
import DirectoryPicker from './DirectoryPicker.vue'

const props = defineProps<{
  bridge: Bridge
  /** A directory to prefill, e.g. the active session's workspace. */
  suggestedPath?: string | null
}>()

const target = ref(props.suggestedPath ?? '')
const status = ref<VetStatus | null>(null)
const result = ref<{ ok: boolean; error?: string; report?: VetReport; meta?: Record<string, unknown> } | null>(null)
const running = ref(false)
const pickerOpen = ref(false)
/** Which severity groups the user has expanded; findings can number in the hundreds. */
const openGroups = ref<Set<string>>(new Set(['critical', 'high']))

const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  info: '提示',
}

const VERDICT_LABEL: Record<string, string> = {
  critical: '发现严重问题',
  suspicious: '可疑',
  clean: '未发现决定性风险',
}

const VERDICT_CLASS: Record<string, string> = {
  critical: 'au__verdict--bad',
  suspicious: 'au__verdict--warn',
  clean: 'au__verdict--ok',
}

onMounted(async () => {
  status.value = await props.bridge.vetStatus()

  // Development affordance, matching the `?settings=` convention: `?audit=<dir>` prefills and runs
  // immediately, so a populated report is reachable in a headless screenshot without clicking.
  const requested = new URLSearchParams(location.search).get('audit')
  if (requested) {
    target.value = requested
    if (status.value.available) await run()
  }
})

async function run() {
  if (!target.value.trim()) return
  running.value = true
  result.value = null
  try {
    result.value = await props.bridge.vetScan(target.value.trim())
  } catch (cause) {
    result.value = { ok: false, error: String((cause as Error).message ?? cause) }
  } finally {
    running.value = false
  }
}

function toggleGroup(severity: string) {
  const next = new Set(openGroups.value)
  if (next.has(severity)) next.delete(severity)
  else next.add(severity)
  openGroups.value = next
}

function isOpen(severity: string) {
  return openGroups.value.has(severity)
}

const report = computed(() => (result.value?.ok ? result.value.report ?? null : null))

/**
 * Whether any decisive finding exists. `staticScore` is a HEALTH score — the engine computes
 * `100 - Σ(weight × confidence)` — so a HIGH score is good. Reading it as a risk score is the easy
 * mistake, so severity counts drive the summary here and the score is shown as a secondary number.
 */
const decisiveCount = computed(() => {
  const findings = report.value?.findings ?? []
  return findings.filter((finding) => finding.severity !== 'info').length
})

const capabilityRows = computed(() => {
  const capabilities = report.value?.capabilities
  if (!capabilities) return []
  const rows: Array<[string, string]> = []
  rows.push(['联网能力', capabilities.hasNetwork ? '有' : '无'])
  rows.push(['执行子进程', capabilities.hasExec ? '有' : '无'])
  if (capabilities.hosts.length > 0) rows.push(['连接的域名', capabilities.hosts.join('、')])
  if (capabilities.spawnCmds.length > 0) rows.push(['执行的命令', capabilities.spawnCmds.slice(0, 8).join('、')])
  if (capabilities.imports.length > 0) rows.push(['引入的模块', capabilities.imports.slice(0, 12).join('、')])
  if (capabilities.hasNativeBinary) {
    rows.push(['原生二进制', (capabilities.nativeBinaries ?? []).join('、') || '有'])
  }
  if ((capabilities.ghostDeps ?? []).length > 0) rows.push(['幽灵依赖', (capabilities.ghostDeps ?? []).join('、')])
  if ((capabilities.zombieDeps ?? []).length > 0) rows.push(['僵尸依赖', (capabilities.zombieDeps ?? []).join('、')])
  return rows
})

function findingKey(finding: VetFinding, index: number) {
  return `${finding.rule}-${finding.file ?? ''}-${finding.line ?? ''}-${index}`
}
</script>

<template>
  <div>
    <h3 class="st__h">安全审计</h3>
    <p class="st__sub">
      在把第三方插件或技能放进工作区之前先审计它。静态扫描在本机进行，不会上传任何文件
      —— 除非显式勾选联网核对漏洞库。
    </p>

    <div v-if="status && !status.available" class="st__hint au__unavailable">
      审计引擎不可用：{{ status.reason }}
    </div>

    <template v-else>
      <div class="st__field">
        <label class="st__label" for="audit-path">要审计的目录</label>
        <div class="au__bar">
          <input
            id="audit-path"
            v-model="target"
            class="field__input au__input"
            placeholder="例如 D:\my-plugins\some-plugin 或某个技能目录"
            spellcheck="false"
            @keyup.enter="run"
          />
          <button class="tinyButton tinyButton--text" type="button" @click="pickerOpen = true">浏览…</button>
          <button class="tinyButton tinyButton--primary" type="button" :disabled="running || !target.trim()" @click="run">
            {{ running ? '审计中…' : '开始审计' }}
          </button>
        </div>
        <p class="st__hint">
          扫描 <code>SKILL.md</code>、<code>CLAUDE.md</code>、配置文件与源码；跳过
          <code>node_modules</code>，也不跟随符号链接。
        </p>
      </div>

      <p v-if="running" class="st__hint">正在解析源码并应用规则…</p>

      <!-- A failure must never look like a pass. -->
      <div v-if="result && !result.ok" class="au__fail">
        <div class="au__failTitle">无法完成审计</div>
        <p class="au__failBody">{{ result.error }}</p>
      </div>

      <template v-if="report">
        <div class="au__verdict" :class="VERDICT_CLASS[report.verdict] ?? ''">
          <div class="au__verdictTop">
            <span class="au__verdictText">{{ VERDICT_LABEL[report.verdict] ?? report.verdict }}</span>
            <span class="au__score" :title="'健康分：100 减去各类问题的加权扣分，分数越高越好'">
              健康分 {{ report.staticScore }}
            </span>
          </div>
          <p class="au__verdictSub">
            规则集 <code>{{ report.engine }}</code> · 解析 {{ report.sourceCount }} 个文件 ·
            共 {{ report.findings.length }} 条，其中决定性 {{ decisiveCount }} 条
          </p>
          <p v-if="result?.meta?.truncatedNotice" class="au__truncated">
            ⚠ {{ result.meta.truncatedNotice }}
          </p>
          <p v-if="report.findings.length === 0" class="au__verdictSub">
            没有命中任何规则。这只说明静态规则没有发现问题，不代表代码一定安全。
          </p>
        </div>

        <div v-if="capabilityRows.length > 0" class="st__field">
          <label class="st__label">能力清单</label>
          <div class="au__caps">
            <div v-for="row in capabilityRows" :key="row[0]" class="au__capRow">
              <span class="au__capKey">{{ row[0] }}</span>
              <span class="au__capValue">{{ row[1] }}</span>
            </div>
          </div>
        </div>

        <div v-for="group in report.groups ?? []" :key="group.severity" class="st__field">
          <button class="au__groupHead" type="button" @click="toggleGroup(group.severity)">
            <span class="reason__caret" :class="{ 'reason__caret--open': isOpen(group.severity) }" />
            <span class="au__sev" :class="`au__sev--${group.severity}`">{{ SEVERITY_LABEL[group.severity] ?? group.severity }}</span>
            <span class="au__groupCount">{{ group.items.length }} 条</span>
          </button>

          <div v-if="isOpen(group.severity)" class="au__findings">
            <div v-for="(finding, index) in group.items" :key="findingKey(finding, index)" class="au__finding">
              <div class="au__findingTop">
                <span class="au__rule">{{ finding.rule }}</span>
                <span class="au__confidence">{{ finding.confidence }}</span>
                <span v-if="finding.decodedFrom" class="au__decoded">解码自 {{ finding.decodedFrom }}</span>
              </div>
              <div class="au__message">{{ finding.message }}</div>
              <div v-if="finding.file" class="au__where">
                {{ finding.file }}<template v-if="finding.line">:{{ finding.line }}</template>
              </div>
              <pre v-if="finding.evidence" class="au__evidence">{{ finding.evidence }}</pre>
            </div>
          </div>
        </div>
      </template>
    </template>

    <DirectoryPicker
      v-if="pickerOpen"
      :initial-path="target"
      @close="pickerOpen = false"
      @select="(path: string) => { target = path; pickerOpen = false }"
    />
  </div>
</template>

<style scoped>
.au__bar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.au__input {
  flex: 1;
  min-width: 0;
}

.au__unavailable {
  color: var(--dsw-alias-state-warn-primary);
}

.au__fail {
  margin-top: 12px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 12px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.au__failTitle {
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  font-weight: 600;
}

.au__failBody {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  word-break: break-word;
}

.au__verdict {
  margin-top: 14px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.au__verdict--ok {
  border-color: var(--dsw-alias-state-success-primary);
}

.au__verdict--warn {
  border-color: var(--dsw-alias-state-warn-primary);
}

.au__verdict--bad {
  border-color: var(--dsw-alias-state-error-primary);
}

.au__verdictTop {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.au__verdictText {
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
}

.au__score {
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 12px;
}

.au__verdictSub {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.au__truncated {
  margin: 6px 0 0;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11.5px;
}

.au__caps {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.au__capRow {
  display: flex;
  gap: 10px;
  font-size: 12px;
}

.au__capKey {
  flex: 0 0 84px;
  color: var(--dsw-alias-label-caption);
}

.au__capValue {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  word-break: break-all;
}

.au__groupHead {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.au__groupHead:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.au__sev {
  font-size: 12px;
  font-weight: 600;
}

.au__sev--critical {
  color: var(--dsw-alias-state-error-primary);
}

.au__sev--high {
  color: var(--dsw-alias-state-warn-primary);
}

.au__sev--medium,
.au__sev--info {
  color: var(--dsw-alias-label-secondary);
}

.au__groupCount {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.au__findings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.au__finding {
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.au__findingTop {
  display: flex;
  align-items: center;
  gap: 8px;
}

.au__rule {
  color: var(--dsw-alias-label-primary-bluish);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  font-weight: 600;
}

.au__confidence,
.au__decoded {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.au__message {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.au__where {
  margin-top: 3px;
  color: var(--dsw-alias-label-dimmed);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  word-break: break-all;
}

.au__evidence {
  margin: 6px 0 0;
  padding: 6px 8px;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
