/**
 * Shell services behind the top menu bar: the log ring, the author card, the shop catalogue, and the
 * feedback inbox.
 *
 * WHY THESE LIVE IN THE BRIDGE RATHER THAN THE PAGE: all four touch the machine — a log file on
 * disk, a feedback entry that must survive a crash, an Explorer window opened at a path. A page can
 * hold none of that, and a page that pretends to (writing "sent" when nothing left the process) is
 * worse than one that says it cannot.
 *
 * The log ring is deliberately a RING: this is a desktop app that can run for weeks, and an
 * unbounded array of log lines is a memory leak with a friendly name.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { dataFile, logsDir } from './paths.mjs'

/** Author card, kept as data so the window carries no copy of its own. */
export const AUTHOR = {
  name: '水哥',
  alias: 'WPH666-py',
  wechat: '18563982192',
  email: '943050454@qq.com',
  github: 'https://github.com/WPH666-py/ChinaClaude',
  gitee: 'https://gitee.com/ph-wang/ChinaClaude',
  intro: [
    '用户您好，我是青岛理工大学临沂校区 2022 级毕业生，你可以叫我水哥（因为之前的 QQ 昵称是「上善若水」，被校园频道上个别的黑子小小地嘲讽了一把）。',
    '目前的理想是从零开始，做真正属于中国人自研的 AI 智能体编辑器，用最简单、轻量化、高可用的架构，做最牛批的开源产品，让每个国人都能以最低的学习成本和金钱成本，直接上手 AI 智能体。',
  ],
  signoff: '水哥等你。',
}

/**
 * 休闲食品商城 catalogue.
 *
 * Kept verbatim from the author's own storefront, images included: these are real products with real
 * purchase links, so inventing placeholder entries would be worse than shipping none.
 */
export const SHOP_PRODUCTS = [
  {
    image: 'biscuit-no-sucrose.jpg',
    name: '青食不加蔗糖钙奶饼干（咸味/原味）',
    detail: '0 添加蔗糖 · 高钙 · 200g 装',
    url: 'https://mobile.yangkeduo.com/goods1.html?ps=lA8lZezJNq',
  },
  {
    image: 'biscuit-sandwich.jpg',
    name: '青食夹心饼干（蓝莓/草莓/牛奶/巧克力）',
    detail: '四种口味 · 随意搭配 · 100g 装',
    url: 'https://mobile.yangkeduo.com/goods1.html?ps=ahGuNYjRpL',
  },
  {
    image: 'biscuit-coconut.jpg',
    name: '青食生椰/香椰/金椰黄油饼干',
    detail: '0 反式脂肪酸 · 咔嚓一下 · 50g 装',
    url: 'https://mobile.yangkeduo.com/goods.html?ps=z9M8OzjX3I',
  },
  {
    image: 'biscuit-animal.jpg',
    name: '青食动物饼干 / 字母饼干',
    detail: '始于 1950 年 · 奶香酥脆 · 易溶水',
    url: 'https://mobile.yangkeduo.com/goods1.html?ps=EwNOTuUVKR',
  },
  {
    image: 'snack-pineapple.jpg',
    name: '青食菠萝豆（鸡蛋菠萝豆）',
    detail: '产地直发 · 正品保证 · 80g 装',
    url: 'https://mobile.yangkeduo.com/goods1.html?ps=K5qgUNwvMY',
  },
  {
    image: 'biscuit-1950.jpg',
    name: '青食 1950 版钙奶饼干（铁锌/钙奶 多口味）',
    detail: '无水奶油 · 怀旧甄选 · 优质精选小麦 · 48g 小包装',
    url: 'https://mobile.yangkeduo.com/goods2.html?ps=Xt9qw1Tc0P',
  },
  {
    image: 'biscuit-calcium-mini.jpg',
    name: '青食精制/铁锌/特制钙奶饼干（迷你包装）',
    detail: '精致 · 铁锌 · 钙奶 三种口味 · 48g 迷你装',
    url: 'https://mobile.yangkeduo.com/goods2.html?ps=fptDgcMjqA',
  },
  {
    image: 'biscuit-truffle.jpg',
    name: '青食黑松露火腿苏打饼干',
    detail: '黑松露风味 × 火腿风味 · 90g 装',
    url: 'https://mobile.yangkeduo.com/goods.html?ps=2C49YaILEg',
  },
  {
    image: 'peanut-butter.jpg',
    name: '青食幼滑/颗粒花生酱（小罐装）',
    detail: '幼滑型 / 颗粒型 · 210g 小瓶',
    url: 'https://mobile.yangkeduo.com/goods2.html?ps=jxPTKChL41',
  },
]

/**
 * Strip ANSI escapes and control characters.
 *
 * A log window is a text view, not a terminal: colour codes that a console would swallow show up
 * here as literal `\u001b[36m` noise, and a stray carriage return can rewind a line on screen.
 */
export function stripAnsi(text) {
  /* eslint-disable-next-line no-control-regex */
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
}

/**
 * The in-memory log ring plus the file it mirrors.
 *
 * @param {object} [options]
 * @param {number} [options.limit]  how many lines are retained in memory
 * @param {string} [options.file]   absolute path of the mirrored log file
 */
export function createLogRing({ limit = 2000, file } = {}) {
  const target = file ?? join(logsDir(), 'bridge.log')
  /** @type {{seq:number, at:number, level:string, source:string, text:string}[]} */
  const lines = []
  let seq = 0
  let dropped = 0

  function append(level, text, source = 'bridge') {
    const clean = stripAnsi(text).replace(/\s+$/, '')
    if (clean === '') return null
    const entry = { seq: ++seq, at: Date.now(), level, source, text: clean }
    lines.push(entry)
    if (lines.length > limit) {
      // Counted rather than silently dropped: "the first N lines are gone" is information, and a
      // viewer that hides it makes a truncated log look complete.
      dropped += lines.length - limit
      lines.splice(0, lines.length - limit)
    }
    try {
      appendFileSync(target, `${new Date(entry.at).toISOString()} [${level}] [${source}] ${clean}\n`)
    } catch {
      // A read-only or full disk must not take the app down over a log line.
    }
    return entry
  }

  /**
   * Mirror the process's own stdout/stderr into the ring.
   *
   * Patching the write methods (rather than only logging explicitly) is what makes the window show
   * UNPLANNED output too — a Node deprecation warning, a stack trace from a spawned process's pipe.
   * The original writers are always called, so nothing is swallowed by being observed.
   */
  function tee() {
    for (const [stream, level, source] of [
      [process.stdout, 'info', 'stdout'],
      [process.stderr, 'error', 'stderr'],
    ]) {
      const original = stream.write.bind(stream)
      stream.write = (chunk, encoding, callback) => {
        try {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
          for (const line of text.split('\n')) append(level, line, source)
        } catch {
          /* observation must never break the write it observes */
        }
        return original(chunk, encoding, callback)
      }
    }
  }

  return {
    append,
    tee,
    file: target,
    clear() {
      lines.length = 0
      dropped = 0
      try {
        writeFileSync(target, '')
      } catch {
        /* nothing to do — the file may be locked by another reader */
      }
      return { cleared: true, file: target }
    },
    snapshot(since = 0) {
      return {
        file: target,
        exists: existsSync(target),
        size: existsSync(target) ? statSync(target).size : 0,
        dropped,
        // `since` is a sequence cursor, so the window can poll for the tail instead of refetching
        // two thousand lines every second.
        lines: lines.filter((line) => line.seq > since),
        lastSeq: seq,
      }
    },
  }
}

/**
 * Open the log file in the OS file manager, selected.
 *
 * Windows `explorer.exe /select,<path>` is the only way to open a FOLDER with a file highlighted —
 * opening the file itself would launch a text editor and hide the point, which is the folder.
 */
export function revealLogFile(file) {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' })
    child.unref()
    return { revealed: true, file }
  }
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' })
  child.unref()
  return { revealed: true, file: dir }
}

/**
 * The feedback inbox.
 *
 * Entries are stored locally FIRST and only then offered to the transport. Delivery here is the
 * user's own mail client via `mailto:`, which needs no server and no credential the app does not
 * have — so the honest guarantee is "it is saved, and here is the one click that sends it", not a
 * fabricated "已发送".
 */
export function createFeedbackInbox({ file } = {}) {
  const target = file ?? dataFile('feedback.jsonl')

  function list(limit = 50) {
    if (!existsSync(target)) return []
    try {
      return readFileSync(target, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .reverse()
    } catch {
      return []
    }
  }

  function submit({ message, email, kind = 'feedback' }) {
    const text = String(message ?? '').trim()
    const address = String(email ?? '').trim()
    if (text === '') return { ok: false, error: '请先填写评价与反馈内容' }
    if (address === '') return { ok: false, error: '请填写您的邮箱，否则作者无法回复您' }

    const entry = { at: Date.now(), kind, message: text, email: address, version: null }
    try {
      appendFileSync(target, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      return { ok: false, error: `本地保存失败：${String(error?.message ?? error)}` }
    }

    const subject = encodeURIComponent(`ChinaClaude 反馈 - ${address}`)
    const body = encodeURIComponent(`${text}\n\n---\n回信邮箱：${address}\n`)
    return {
      ok: true,
      saved: true,
      file: target,
      // The page opens this; the bridge does not pretend to have sent anything.
      mailto: `mailto:${AUTHOR.email}?subject=${subject}&body=${body}`,
      hint: '已保存到本机。点「用邮件发送」会在你的邮件客户端里打开一封写好的信，发出去即送达作者。',
    }
  }

  return { submit, list, file: target }
}

export { dataFile }
