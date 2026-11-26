import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTopicDeduper, topicSimilarity } from '../src/index.ts'

describe('topic-dedupe', () => {
  it('computes normalized mixed Chinese/English bigram Dice similarity', () => {
    assert.equal(topicSimilarity('今天天气真好', '今天天气真好'), 1)
    assert.equal(topicSimilarity('', 'abc'), 0)
    assert.equal(topicSimilarity('...', '   '), 0)
    assert.equal(topicSimilarity('猫', '猫'), 1)
    assert.equal(topicSimilarity('猫', '狗'), 0)

    const simZh = topicSimilarity('分享一首最近听的歌', '分享最近听的一首歌')
    assert.ok(simZh >= 0.55, `expected Chinese similar topics >= 0.55, got ${simZh}`)

    const simEn = topicSimilarity('Weekend Hiking Plan!', 'weekend hiking plans')
    assert.ok(simEn >= 0.9, `expected English similar topics >= 0.9, got ${simEn}`)

    const diff = topicSimilarity('TypeScript 编译器原理', '周末去爬香山看红叶')
    assert.ok(diff < 0.2, `expected distinct topics < 0.2, got ${diff}`)
  })

  it('blocks similar topics within windowMs, expires after windowMs, and evicts beyond maxEntries', () => {
    const deduper = createTopicDeduper({
      windowMs: 1_000,
      maxEntries: 2,
      threshold: 0.55,
    })

    deduper.record('ch1', '分享最近听的一首歌', 100)
    const blocked = deduper.check('ch1', '分享一首最近听的歌', 200)
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.matchedTopic, '分享最近听的一首歌')
    assert.ok(blocked.maxSimilarity >= 0.55)

    // Unrelated topic on same channel is allowed
    const distinct = deduper.check('ch1', '聊聊今晚吃什么火锅', 200)
    assert.equal(distinct.allowed, true)

    // Different channel is isolated
    const otherChannel = deduper.check('ch2', '分享一首最近听的歌', 200)
    assert.equal(otherChannel.allowed, true)

    // Right before windowMs (100 + 999 = 1099), still blocked; at windowMs (1100), allowed again
    assert.equal(deduper.check('ch1', '分享一首最近听的歌', 1_099).allowed, false)
    const expired = deduper.check('ch1', '分享一首最近听的歌', 1_100)
    assert.equal(expired.allowed, true)
    assert.equal(expired.maxSimilarity, 0)

    // Exact threshold boundary (similarity === threshold => blocked)
    const strictDeduper = createTopicDeduper({ threshold: 1 })
    strictDeduper.record('ch-eq', 'exact', 0)
    assert.equal(strictDeduper.check('ch-eq', 'exact', 10).allowed, false)

    // Evicts oldest when exceeding maxEntries = 2
    deduper.record('ch3', '话题一：猫猫', 1_000)
    deduper.record('ch3', '话题二：电影', 1_010)
    deduper.record('ch3', '话题三：咖啡', 1_020)
    assert.equal(deduper.check('ch3', '话题一：猫猫', 1_030).allowed, true)
    assert.equal(deduper.check('ch3', '话题三：咖啡', 1_030).allowed, false)

    // Snapshot & restore round-trip
    const snap = JSON.parse(JSON.stringify(deduper.snapshot())) as unknown
    const restored = createTopicDeduper({ windowMs: 1_000, maxEntries: 2, threshold: 0.55 })
    restored.restore(snap)
    assert.equal(restored.check('ch3', '话题三：咖啡', 1_030).allowed, false)
  })
})
