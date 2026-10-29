import { readFileSync, writeFileSync } from 'node:fs'

let text = readFileSync('packages/bridge/src/session.mjs', 'utf8').replace(/\r\n/g, '\n')

/* 1) 恢复会话时把用户消息也显示出来 */
const before = `      return null
    }

    case 'result':`
if (!text.includes(before)) throw new Error('user case anchor missing')
text = text.replace(
  before,
  `      /**
       * 用户消息。
       *
       * WHY IT MATTERS: 恢复会话（--resume）时 CLI 会把历史重放一遍；以前这里一律返回 null，
       * 于是重开一个会话只看得到回答和工具调用，看不到自己问过什么 —— 看起来像「每回合没保留提问」。
       */
      const textBlock = blocks.find((item) => item?.type === 'text')
      const said = typeof textBlock?.text === 'string' ? textBlock.text : ''
      if (said.trim() === '') return null
      return { ...base, kind: 'user', text: said, replayed: true }
    }

    case 'result':`,
)

/* 2) 去重：本地发送时已经推过一条同样的用户事件，CLI 回显同一条时不要变成两个气泡 */
const pushAnchor = '  #pushEvent(event) {'
if (!text.includes(pushAnchor)) throw new Error('pushEvent anchor missing')
text = text.replace(
  pushAnchor,
  `  #pushEvent(event) {
    /**
     * 同一条用户消息只保留一条。
     *
     * 发送时本地会先推一条（界面立刻可见），CLI 在历史重放或回显时会再给一条同文事件。
     * 两条并存的结果就是每个提问都出现两次；只在很短的时间窗内、且内容完全相同才合并，
     * 避免把「用户真的把同一句话发了两遍」也吞掉。
     */
    if (event.kind === 'user' && typeof event.text === 'string') {
      for (let index = this.history.length - 1; index >= 0; index -= 1) {
        const previous = this.history[index]
        if (previous.kind !== 'user') continue
        if ((previous.text ?? '') === event.text && Math.abs((previous.at ?? 0) - (event.at ?? 0)) < 5000) return
        break
      }
    }`,
)

writeFileSync('packages/bridge/src/session.mjs', text, 'utf8')
console.log('user replay + dedupe')
