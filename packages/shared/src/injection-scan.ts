/** Flags text that tries to replace the kernel's instructions rather than be remembered as content. */

const RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /忽略(之前|以上|上面|前面|所有)的?(指令|设定|规则|要求|提示)/i, reason: '要求忽略之前的指令' },
  { pattern: /无视(之前|以上|上面|前面|所有)的?(指令|设定|规则)/i, reason: '要求无视之前的指令' },
  { pattern: /你现在是/i, reason: '试图改写角色' },
  { pattern: /系统提示词/i, reason: '提到系统提示词' },
  { pattern: /ignore (all )?(previous|prior|above) (instructions|prompts)/i, reason: 'asks to ignore earlier instructions' },
  { pattern: /disregard (all )?(previous|prior|above) instructions/i, reason: 'asks to disregard earlier instructions' },
  { pattern: /system prompt/i, reason: 'mentions the system prompt' },
  { pattern: /<\/?(wake|memory|messages|system|handoff|recent-self|mood)\b/i, reason: 'contains a kernel tag' },
]

/** Returns a reason when the text looks like an instruction injection, otherwise null. */
export function scanInjection(text: string): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.reason
  }
  return null
}
