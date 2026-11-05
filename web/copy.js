// Pools of rotating copy. The first line of every pool is the stable one screen readers get, so it is
// always true without data. Data lines only appear when the archive supports them (pure, unit-tested).
const n = value => (value || 0).toLocaleString('zh-CN')
const md = date => { const [, m, d] = date.split('-').map(Number); return `${m} 月 ${d} 日` }
const ymd = date => { const [y, m, d] = date.split('-').map(Number); return `${y} 年 ${m} 月 ${d} 日` }
const hour = e => Number(e.time.slice(0, 2))
const PERIODS = [[0, 5, '凌晨'], [5, 9, '清晨'], [9, 12, '上午'], [12, 18, '午后'], [18, 21, '傍晚'], [21, 24, '夜里']]

export const WELCOME_LINES = [
  '每首歌，都有第一次响起的那天。',
  '后来循环了无数遍的歌，也曾是第一次。',
  '有些旋律，第一次听见就留了下来。',
  '记不清是哪天，但它一定在某天出现过。'
]
export const SYNCING_LINES = [
  '正在一首首翻找，你和它们相遇的日子。',
  '从你最近喜欢上的歌开始，慢慢往回找。',
  '第一批初听，很快就会出现在下面。'
]
export const LOADING_LINES = ['正在翻开你的初听…', '把唱片从封套里取出来…', '正在对齐每一首歌的日子…']
export const INTRO_TITLES = ['扫一次码，剩下的交给它', '你喜欢的歌，都有个生日', '不用导入，不用挑选，连上就好', '把散落的初听，排成一条时间线']
export const CLOSING_LINES = [
  '第一次只有一次，所以值得*记下来*。',
  '后来的每一遍，都从*这一次*开始。',
  '愿你还会遇见很多首，让你*停下来*的歌。',
  '下一首让你停下来的歌，会在*哪天*出现？'
]
export const SYNCING_EMPTY = [
  '第一首马上就到。',
  '先去倒杯水，回来就有了。',
  '正在一首首问网易云…'
]
export function endTitles(order) {
  return order === 'newest'
    ? ['再往前，是还没被找回的日子。', '走到这里，就是最早的那一首了。', '故事的开头，往往比记得的更早。']
    : ['故事暂时写到这里。', '下一首初听，也许就在明天。', '未完，待续。']
}

// events: first-listen events sorted oldest first.
export function taglines(events) {
  if (!events.length) return WELCOME_LINES
  const out = [WELCOME_LINES[0]]
  const days = new Set(events.map(e => e.date)).size
  if (events.length >= 3) out.push(`${n(events.length)} 首歌，${n(days)} 个日子，每一首都有它的第一天。`)
  const top = events.reduce((a, e) => ((e.play_count || 0) > (a?.play_count || 0) ? e : a), null)
  if (top && top.play_count >= 2) out.push(`《${top.name}》听了 ${n(top.play_count)} 遍，第一次是在 ${ymd(top.date)}。`)
  if (events.length >= 6) {
    const counts = PERIODS.map(([a, b]) => events.filter(e => hour(e) >= a && hour(e) < b).length)
    const i = counts.indexOf(Math.max(...counts))
    if (counts[i] / events.length >= .3) out.push(`你最常在${PERIODS[i][2]}遇见新歌。`)
  }
  const first = events[0], last = events.at(-1)
  const months = (Number(last.date.slice(0, 4)) - Number(first.date.slice(0, 4))) * 12 + Number(last.date.slice(5, 7)) - Number(first.date.slice(5, 7))
  if (months >= 24) out.push(`这条时间线，已经走了 ${Math.floor(months / 12)} 年多。`)
  else if (months >= 2) out.push(`这条时间线，已经走了 ${months} 个月。`)
  if (events.length >= 2) out.push(`最近一次心动，是 ${md(last.date)}的《${last.name}》。`)
  out.push(WELCOME_LINES[2])
  return out
}
export function timelineLedes(events, order) {
  const out = ['每一行，都是一首歌第一次响起的时刻。']
  out.push(order === 'newest' ? '最新的在上面，往下翻就是往回走。' : '从第一首开始，按日子往后讲。')
  if (events.length) {
    const perDay = new Map()
    for (const e of events) perDay.set(e.date, (perDay.get(e.date) || 0) + 1)
    let busy = null, k = 0
    for (const [d, c] of perDay) if (c > k) { busy = d; k = c }
    if (k >= 2) out.push(`最热闹的一天是 ${ymd(busy)}，一天遇见了 ${n(k)} 首。`)
    const first = events[0].date, last = events.at(-1).date
    const span = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1
    const active = new Set(events.map(e => e.date.slice(0, 7))).size
    if (span >= 4) out.push(active / span >= .7 ? `这 ${n(span)} 个月里，你几乎每个月都在遇见新歌。` : '有的月份很热闹，有的月份很安静。')
  }
  out.push('点开哪首都行，看看那天。')
  return out
}
