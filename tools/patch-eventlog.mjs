import { readFileSync, writeFileSync } from 'node:fs'

let text = readFileSync('packages/bridge/src/session.mjs', 'utf8').replace(/\r\n/g, '\n')

/* imports */
text = text.replace(
  "import { appendFileSync, existsSync } from 'node:fs'",
  "import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'",
)
text = text.replace(
  "import { randomUUID } from 'node:crypto'",
  "import { randomUUID } from 'node:crypto'\nimport { join } from 'node:path'\nimport { dataSubDir } from './paths.mjs'",
)

/* 恢复磁盘日志：构造函数里 history 初始化之后 */
const initAnchor = '    this.history = []\n'
if (!text.includes(initAnchor)) throw new Error('history init anchor missing')
text = text.replace(
  initAnchor,
  `    this.history = []
    /**
     * 事件日志的磁盘副本。
     *
     * 内存里的 history 只活到进程结束：用户中途关掉再打开，会话就只剩快照里的最后 2000 条，
     * 更早的提问和回答都消失。这里把每个会话的事件按行落盘，启动时读回来 —— 「已结束」于是
     * 只表示当前没有子进程在跑，记录本身不会丢。
     */
    this.eventLogFile = this.#eventLogPath()
    this.#restoreEventLog()
`,
)

/* 方法：放在 #billingModel 之前 */
const anchor = '  /** The model a turn started right now would run on. */'
if (!text.includes(anchor)) throw new Error('method anchor missing')
text = text.replace(
  anchor,
  `  /** 这个会话的事件日志文件（JSONL，一行一个事件）。 */
  #eventLogPath() {
    try {
      return join(dataSubDir('session-events'), \`\${this.id}.jsonl\`)
    } catch {
      return null
    }
  }

  /** 把磁盘上的事件读回 history（最多 6000 条，覆盖超长会话的开头）。 */
  #restoreEventLog() {
    if (!this.eventLogFile) return
    try {
      if (!statSync(this.eventLogFile).isFile()) return
      const raw = readFileSync(this.eventLogFile, 'utf8')
      const restored = []
      for (const line of raw.split('\\n')) {
        if (line.trim() === '') continue
        try {
          const event = JSON.parse(line)
          if (event && typeof event === 'object') restored.push(event)
        } catch {
          /* 写到一半被杀留下的半行，忽略 */
        }
      }
      if (restored.length === 0) return
      this.history = restored.slice(-6000)
      const last = this.history[this.history.length - 1]
      if (Number.isFinite(last?.seq)) this.seq = last.seq
    } catch {
      /* 读不出来就当没有，绝不影响启动 */
    }
  }

  /** 追加一条事件到日志；失败只丢日志，不影响对话。 */
  #appendEventLog(event) {
    if (!this.eventLogFile || !Number.isFinite(event?.seq)) return
    try {
      appendFileSync(this.eventLogFile, \`\${JSON.stringify(event)}\\n\`, 'utf8')
    } catch {
      /* best effort */
    }
  }

${anchor}`,
)

/* 推事件时落盘 */
const pushAnchor = '    this.history.push(sequenced)\n'
if (!text.includes(pushAnchor)) throw new Error('push anchor missing')
text = text.replace(pushAnchor, `${pushAnchor}    this.#appendEventLog(sequenced)\n`)

writeFileSync('packages/bridge/src/session.mjs', text, 'utf8')
console.log('event log wired')
