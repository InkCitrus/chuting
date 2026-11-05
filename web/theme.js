/* Theme boot: runs as a classic script before CSS so the first paint matches the saved choice.
   Values: system | light | dark. Stored under chuting-theme. */
(() => {
  const KEY = 'chuting-theme'
  const COLORS = { light: '#f5f2ec', dark: '#121110' }
  const root = document.documentElement
  const read = () => {
    try {
      const v = localStorage.getItem(KEY)
      return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
    } catch { return 'system' }
  }
  const resolved = mode => {
    if (mode === 'light' || mode === 'dark') return mode
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  const paint = mode => {
    const choice = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system'
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)
    const tone = resolved(choice)
    root.style.colorScheme = tone
    const color = COLORS[tone]
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.append(meta)
    }
    meta.content = color
    meta.removeAttribute('media')
    // Drop media-scoped duplicates so the forced theme wins in the browser chrome.
    for (const el of [...document.querySelectorAll('meta[name="theme-color"]')]) {
      if (el !== meta) el.remove()
    }
  }
  const apply = mode => {
    const choice = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system'
    try { localStorage.setItem(KEY, choice) } catch {}
    paint(choice)
    return choice
  }
  paint(read())
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const onSystem = () => { if (read() === 'system') paint('system') }
  mq.addEventListener?.('change', onSystem) || mq.addListener?.(onSystem)
  window.__chutingTheme = { KEY, read, apply, resolved, paint, COLORS }
})()
