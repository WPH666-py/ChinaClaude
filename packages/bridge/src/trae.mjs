/**
 * Trae 接入（MCP 方向）：让 Trae 作为 MCP 客户端连到本应用的 MCP 服务。
 *
 * WHY THIS DIRECTION: the objective asked to route conversations THROUGH Trae's model, but the
 * reconnaissance (three rounds) found no readable login, no chat CLI, and no local API — Trae only
 * exposes VS Code's extension host. The one sanctioned integration it does document is MCP on the client
 * side (`trae.mcp.enableWorkspaceMcp` exists in this machine's settings). So the honest deliverable is the
 * supported direction: Trae's agent can call the tools this app already serves over MCP.
 *
 * WHY WE DO NOT WRITE TRAE'S CONFIG: Trae stores MCP servers through its own UI/store, not a file whose
 * schema we have verified on this machine. Emitting a snippet the user pastes is reversible and cannot
 * corrupt an editor profile; guessing a path and writing JSON there could.
 */
import { existsSync, readFileSync } from 'node:fs'
import { decryptTraeStorageValue } from './trae-auth.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Trae CN keeps user settings, per this machine's profile (both the CN and SOLO flavours exist). */
function settingsCandidates() {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [join(roaming, 'Trae CN', 'User', 'settings.json'), join(roaming, 'TRAE SOLO CN', 'User', 'settings.json')]
}

export function traeMcpIntegration({ nodePath, entryPath } = {}) {
  const settingsPath = settingsCandidates().find((path) => existsSync(path)) ?? null
  let workspaceMcp = null
  if (settingsPath) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
      workspaceMcp = typeof parsed?.['trae.mcp.enableWorkspaceMcp'] === 'boolean' ? parsed['trae.mcp.enableWorkspaceMcp'] : null
    } catch {
      workspaceMcp = null
    }
  }

  const node = String(nodePath ?? process.execPath)
  const entry = String(entryPath ?? '')
  const available = entry !== '' && existsSync(entry)
  const snippet = available
    ? {
        mcpServers: {
          'cccn-office': {
            command: node,
            args: [entry],
            env: { CCCN_MCP_ROOT: '<把这里换成你要共享的工作区绝对路径>' },
          },
        },
      }
    : null

  return {
    ok: true,
    direction: 'trae-as-mcp-client',
    settingsPath: settingsPath ? settingsPath.replace(homedir(), '~') : null,
    workspaceMcpEnabled: workspaceMcp,
    serverEntry: available ? entry : null,
    snippet,
    steps: [
      'Trae → 设置 → MCP（或工作区 MCP），添加一个 stdio 服务器。',
      '粘贴下面的 JSON；把 CCCN_MCP_ROOT 改成要共享的工作区路径。',
      '保存后 Trae 的智能体即可调用 word_* / excel_* / ppt_* 工具。',
    ],
    note: workspaceMcp === false
      ? '本机设置里 trae.mcp.enableWorkspaceMcp 为 false：需要先在 Trae 设置里打开工作区 MCP。'
      : '没有读取到 trae.mcp.enableWorkspaceMcp；如果 Trae 里看不到服务器，先检查这个开关。',
    limits: '这是「Trae 调用本应用的工具」，不是「本应用调用 Trae 的模型」。后者没有可用的官方通道，见 /api/connectors/proxy?id=trae。',
  }
}

/**
 * 读取 Trae 桌面端的登录态（端口自插件 dsh-connect-trae 4.0.1）。
 *
 * 工作方式：storage.json → iCubeAuthInfo://icube.cloudide → AES-128-CBC 解密（见 trae-auth.mjs）。
 * 解出的 JSON 含 token / refreshToken / expiredAt / userId / host / account，与机器无关。
 */
function traeStorageCandidates() {
  const roaming = process.env.APPDATA ?? ''
  return [
    join(roaming, 'Trae CN', 'User', 'globalStorage', 'storage.json'),
    join(roaming, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
    join(roaming, 'Trae', 'User', 'globalStorage', 'storage.json'),
    join(roaming, 'Trae CN - Intl', 'User', 'globalStorage', 'storage.json'),
  ].filter((path) => path !== '')
}

export function readTraeDesktopAuth() {
  for (const file of traeStorageCandidates()) {
    if (!existsSync(file)) continue
    try {
      const storage = JSON.parse(readFileSync(file, 'utf8'))
      const raw = storage['iCubeAuthInfo://icube.cloudide']
      if (typeof raw !== 'string' || raw.length < 100) continue
      const auth = JSON.parse(decryptTraeStorageValue(raw))
      if (typeof auth?.token !== 'string' || auth.token === '') continue
      return {
        ok: true,
        token: auth.token,
        expiresAt: auth.expiredAt ?? null,
        userId: auth.userId ?? null,
        host: auth.host ?? null,
        userRegion: auth.userRegion ?? null,
        account: auth.account
          ? { username: auth.account.username ?? null, email: auth.account.email ?? null, userTag: auth.account.userTag ?? null }
          : null,
        file,
      }
    } catch {
      /* 下一份候选：损坏或被改写都按「读不到」处理 */
    }
  }
  return { ok: false, token: null, reason: '没有找到可解密的 Trae 登录态（未安装或未登录）' }
}

/** 面板用的登录状态：只用掩码与到期时间，不返回令牌本身。 */
export function traeAuthStatus() {
  const auth = readTraeDesktopAuth()
  if (!auth.ok) return { ok: true, loggedIn: false, reason: auth.reason }
  const expired = auth.expiresAt ? Date.parse(auth.expiresAt) < Date.now() : false
  return {
    ok: true,
    loggedIn: !expired,
    expired,
    expiresAt: auth.expiresAt,
    account: auth.account?.username ?? auth.account?.email ?? null,
    userId: auth.userId,
    host: auth.host,
    userRegion: auth.userRegion,
    tokenHint: `${auth.token.slice(0, 4)}…${auth.token.slice(-2)}`,
  }
}