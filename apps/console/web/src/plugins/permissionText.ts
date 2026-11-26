import { parsePermission, type PlainPermission } from '@brain-core/sdk'

const PLAIN_TEXT: Readonly<Record<PlainPermission, string>> = {
  'memory.ingest': '把内容写进记忆（原始层）',
  'memory.record': '创建或修改记忆记录',
  'memory.search': '搜索记忆',
  'memory.context': '读取与当前情境相关的记忆',
  'memory.forget': '遗忘指定的记忆',
  'memory.readL0': '读取原始层记忆',
  'memory.writeDerived': '写入由已有记忆推导的记录',
  'agent.session': '发起或使用她的会话',
  'tools.register': '给她注册工具',
  'channel.provide': '提供一个消息通道',
  'channel.send': '通过消息通道发送内容',
  'identity.link': '关联同一个人的不同账号',
  'schedule.ownTime': '为插件安排定时任务',
  'llm.invoke': '调用模型并消耗运行额度',
}

const HIGH_RISK = new Set<PlainPermission>(['channel.send', 'agent.session', 'memory.forget'])

export interface PermissionDescription {
  readonly text: string
  readonly known: boolean
  readonly highRisk: boolean
  readonly lan: boolean
}

export function describePermission(raw: string): PermissionDescription {
  let parsed
  try {
    parsed = parsePermission(raw)
  } catch {
    return { text: raw, known: false, highRisk: false, lan: false }
  }

  const known = { known: true, highRisk: false, lan: false }
  switch (parsed.kind) {
    case 'plain':
      return { ...known, text: PLAIN_TEXT[parsed.name], highRisk: HIGH_RISK.has(parsed.name) }
    case 'network': {
      const wildcard = parsed.host.startsWith('*.')
      return { ...known, text: wildcard ? `访问 ${parsed.host.slice(2)} 下的网站` : `访问网站 ${parsed.host}`, highRisk: wildcard }
    }
    case 'network-config':
      return { ...known, text: `访问配置字段 ${parsed.key} 指定的网站`, highRisk: true }
    case 'lan':
      return { ...known, text: `访问局域网里的设备 ${parsed.host}`, highRisk: true, lan: true }
    case 'lan-config':
      return { ...known, text: `访问配置字段 ${parsed.key} 指定的局域网设备`, highRisk: true, lan: true }
    case 'secret':
      return { ...known, text: `读取密钥库中的 ${parsed.name}`, highRisk: true }
  }
}
