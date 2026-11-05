// Rotating copy. Each spot holds a small pool of lines; all lines are stacked in one grid cell, so the
// box keeps the height of the longest line and nothing below it jumps. Screen readers get one stable
// line (the first of the pool) and no live region. One shared scheduler keeps changes apart from each
// other and from the highlight carousel, and only counts time while a spot is on screen, the tab is
// visible and nobody is hovering or focused on it. Reduced motion: a random line per load, no rotation.
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
const spots = new Map()
const GAP = 1400 // ms between any two copy changes
const SLIDE_GAP = 1100 // ms kept clear around a carousel slide change
let lastFlip = 0, lastSlide = 0, timer = 0, lastTick = 0
const seen = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => { for (const e of entries) { const s = spots.get(e.target); if (s) s.visible = e.isIntersecting } }, { threshold: .4 })
  : null
document.addEventListener('chuting:slide', () => { lastSlide = performance.now() })

function chars(line) {
  // Latin words and numbers stay whole so they never break mid-word; *text* is emphasised.
  const out = document.createDocumentFragment()
  let i = 0
  for (const [k, part] of line.split('*').entries()) {
    const holder = k % 2 ? document.createElement('strong') : out
    for (const token of part.match(/[A-Za-z0-9][A-Za-z0-9.,:%'’\-]*|\s+|./gu) || []) {
      if (/^\s+$/.test(token)) { holder.append(token); continue }
      const c = document.createElement('span')
      c.className = 'rot-c'; c.textContent = token; c.style.setProperty('--ci', Math.min(i++, 30))
      holder.append(c)
    }
    if (holder !== out) out.append(holder)
  }
  return out
}
function plain(line) { return line.replaceAll('*', '') }

function build(el, spot) {
  const stable = document.createElement('span')
  stable.className = 'sr-only'; stable.textContent = plain(spot.pool[0])
  const stack = document.createElement('span')
  stack.className = 'rot-stack'; stack.setAttribute('aria-hidden', 'true')
  spot.lines = spot.pool.map((line, i) => {
    const v = document.createElement('span')
    v.className = 'rot-v' + (i === spot.index ? ' is-on' : '')
    v.append(chars(line))
    stack.append(v)
    return v
  })
  el.classList.add('rot')
  el.replaceChildren(stable, stack)
}

export function rotate(el, pool, options = {}) {
  if (!el) return
  pool = pool.filter(Boolean)
  if (!pool.length) return clearCopy(el, '')
  const key = options.key ?? pool.join('|')
  const old = spots.get(el)
  if (old && old.key === key) return
  const still = reduced.matches || options.still
  const spot = { key, pool, index: still ? Math.floor(Math.random() * pool.length) : 0, interval: options.interval || 9000,
    elapsed: -(options.delay ?? 0), visible: !seen, held: false, still }
  // Keep the line being read when only the data behind it changed.
  if (old && !still) {
    const same = pool.findIndex(l => l === old.pool[old.index])
    spot.index = same >= 0 ? same : Math.min(old.index, pool.length - 1)
    spot.elapsed = old.elapsed; spot.visible = old.visible; spot.held = old.held
  }
  if (!old) {
    el.addEventListener('pointerenter', () => { const s = spots.get(el); if (s) s.held = true })
    el.addEventListener('pointerleave', () => { const s = spots.get(el); if (s) s.held = false })
  }
  spots.set(el, spot)
  build(el, spot)
  seen?.observe(el)
  schedule()
}
export function clearCopy(el, text) {
  if (!el) return
  if (spots.delete(el)) { seen?.unobserve(el); el.classList.remove('rot') }
  if (el.textContent !== text || el.children.length) el.textContent = text
}
function flip(spot) {
  const from = spot.lines[spot.index]
  spot.index = (spot.index + 1) % spot.pool.length
  const to = spot.lines[spot.index]
  from.classList.remove('is-on', 'is-in'); from.classList.add('is-out')
  to.classList.remove('is-out'); to.classList.add('is-on', 'is-in')
  setTimeout(() => from.classList.remove('is-out'), 700)
  setTimeout(() => to.classList.remove('is-in'), 1800)
}
function tick() {
  const now = performance.now(), dt = Math.min(1000, now - lastTick)
  lastTick = now
  if (document.hidden) return
  for (const [el, spot] of spots) {
    if (!el.isConnected) { spots.delete(el); seen?.unobserve(el); continue }
    if (spot.still || spot.pool.length < 2 || !spot.visible || spot.held || el.matches(':focus-within')) continue
    spot.elapsed += dt
    if (spot.elapsed < spot.interval) continue
    if (now - lastFlip < GAP || now - lastSlide < SLIDE_GAP || now - lastSlide > 6500 - SLIDE_GAP && lastSlide && now - lastSlide < 6500 + SLIDE_GAP) continue
    spot.elapsed = 0; lastFlip = now
    flip(spot)
  }
}
function schedule() {
  if (timer || reduced.matches) return
  lastTick = performance.now()
  timer = setInterval(() => { tick(); if (!spots.size) { clearInterval(timer); timer = 0 } }, 250)
}
reduced.addEventListener?.('change', () => {
  for (const spot of spots.values()) spot.still = reduced.matches
  if (reduced.matches) { clearInterval(timer); timer = 0 } else schedule()
})
