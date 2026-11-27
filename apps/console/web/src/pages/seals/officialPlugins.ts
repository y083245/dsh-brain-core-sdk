export interface OfficialPlugin {
  readonly id: string
  readonly spec: string
  readonly title: string
  readonly kind: string
  readonly summary: string
}

export const OFFICIAL_PLUGINS: readonly OfficialPlugin[] = [
  {
    id: 'console-chat', spec: '@dsh-brain-core/plugin-console-chat@next', title: '控制台对话', kind: '通道',
    summary: '墨潮控制台内置聊天通道，安装并启用后即可在网页里对话',
  },
  {
    id: 'qq', spec: '@dsh-brain-core/plugin-qq@next', title: 'QQ 通道', kind: '通道',
    summary: '对接 OneBot v11 协议端，支持私聊/群聊、图文动图与主动消息',
  },
  {
    id: 'web-reader', spec: '@dsh-brain-core/plugin-web-reader@next', title: '网页阅读', kind: '活动',
    summary: '定时抓取公开网页正文并沉淀为可溯源记忆',
  },
  {
    id: 'memory-vector', spec: '@dsh-brain-core/plugin-memory-vector@next', title: '向量检索增强', kind: '记忆提供方',
    summary: '本地 BVEC 量化向量记忆检索，支持可选 HTTP 向量接口',
  },
]

export function availableOfficialPlugins(installedIds?: ReadonlySet<string>): readonly OfficialPlugin[] {
  return OFFICIAL_PLUGINS.filter((plugin) => !installedIds?.has(plugin.id))
}
