// Song player: one <audio>, a dialog control row, a mini bar that stays after the dialog closes, and Media
// Session for lock-screen / OS controls. The playable URL is asked for only when play is pressed (one worker
// call, the account's own rights). Audio streams straight from NetEase's CDN and is never cached.
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
export const PLAYER_LINES = {
  rights: '这首得开会员或单独买才能听。',
  unavailable: '这首暂时放不了，可能下架了。',
  trial: '只能试听一小段。',
  failed: '没放出来，再点一下试试？',
  unsupported: '这首的格式在这边放不了。',
  offline: '没网，先不放歌了。',
  login: '扫码登录后就能听。',
  loading: '正在找这首歌…'
}
// Standard MP3 is the most widely decodable web fallback after a FLAC / hi-res URL fails.
export const FALLBACK_QUERY = { level: 'standard', encodeType: 'mp3' }
export const HARD_TYPES = new Set(['flac', 'wav', 'ape', 'aiff', 'dsf', 'dff'])
export function playErrorMessage(err, mediaError) {
  if (err?.name === 'NotAllowedError') return ''
  if (err?.name === 'AbortError') return null
  if (err?.name === 'NotSupportedError' || mediaError?.code === 4) return PLAYER_LINES.unsupported
  return PLAYER_LINES.failed
}

export function createPlayer({ els, mini, getUrl, coverFor, onEnded, onOpen }) {
  const audio = new Audio()
  audio.preload = 'auto'
  const state = { event: null, answer: null, shown: null, error: '', loading: false, retried: false, offline: false, seeking: false, gen: 0, gain: 1, userVolume: 1, pendingFade: 0 }
  let fadeRaf = 0
  function applyGain(g) {
    state.gain = Math.min(1, Math.max(0, g))
    audio.volume = Math.min(1, Math.max(0, state.userVolume * state.gain))
  }
  function fadeGain(to, ms = 320) {
    cancelAnimationFrame(fadeRaf)
    const from = state.gain, dur = Math.max(0, Number(ms) || 0)
    if (!dur) { applyGain(to); return Promise.resolve() }
    const start = performance.now()
    return new Promise(resolve => {
      const step = now => {
        const t = Math.min(1, (now - start) / dur)
        applyGain(from + (to - from) * t)
        if (t < 1) fadeRaf = requestAnimationFrame(step)
        else resolve()
      }
      fadeRaf = requestAnimationFrame(step)
    })
  }
  function status() {
    return {
      ok: Boolean(state.answer?.url) && !state.error,
      error: state.error || '',
      reason: state.answer?.reason || (state.error ? 'failed' : ''),
      trial: Boolean(state.answer?.trial)
    }
  }
  const isCurrent = () => state.shown && state.event && state.shown.song_id === state.event.song_id
  const setNote = text => { els.note.textContent = text; els.note.hidden = !text }

  function render() {
    const current = isCurrent(), playing = current && !audio.paused
    const unavailable = current && state.answer && !state.answer.url
    els.root.classList.toggle('is-playing', playing)
    els.root.classList.toggle('is-loading', current && state.loading)
    els.root.classList.toggle('is-off', Boolean(state.offline && !current) || Boolean(unavailable))
    els.dialog.classList.toggle('is-playing', playing)
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放')
    els.play.disabled = Boolean(state.offline && !current) || Boolean(unavailable)
    const dur = current ? (audio.duration || (state.answer?.duration || 0) / 1000) : 0
    const pos = current ? audio.currentTime : 0
    if (!state.seeking) els.seek.value = dur ? String(Math.round(pos / dur * 1000)) : '0'
    els.seek.disabled = !current || !dur
    let buf = 0
    if (current && dur) for (let i = 0; i < audio.buffered.length; i++) if (audio.buffered.start(i) <= pos + .5) buf = Math.max(buf, audio.buffered.end(i))
    els.scrub.style.setProperty('--pos', dur ? (pos / dur).toFixed(4) : 0)
    els.scrub.style.setProperty('--buf', dur ? Math.min(1, buf / dur).toFixed(4) : 0)
    els.cur.textContent = fmt(pos)
    els.dur.textContent = dur ? fmt(dur) : '0:00'
    setNote(state.offline && !current ? PLAYER_LINES[state.offline]
      : !current ? '' : state.loading ? PLAYER_LINES.loading : state.error ? state.error
      : state.answer && !state.answer.url ? PLAYER_LINES[state.answer.reason] || PLAYER_LINES.unavailable
      : state.answer?.trial ? PLAYER_LINES.trial : '')
    // Mini bar: visible while something is loaded and the dialog is closed.
    const show = Boolean(state.event && state.answer?.url) && !els.dialog.open
    mini.root.hidden = !show
    document.body.classList.toggle('has-mini', show)
    if (state.event) {
      mini.root.classList.toggle('is-playing', !audio.paused)
      mini.play.setAttribute('aria-label', audio.paused ? '播放' : '暂停')
      mini.root.style.setProperty('--pos', audio.duration ? (audio.currentTime / audio.duration).toFixed(4) : 0)
    }
  }
  function session() {
    if (!('mediaSession' in navigator) || !state.event) return
    const e = state.event, art = coverFor(e)
    navigator.mediaSession.metadata = new MediaMetadata({ title: e.name, artist: e.artists || '', album: e.album || '',
      artwork: art ? [96, 256, 512].map(px => ({ src: art(px), sizes: `${px}x${px}`, type: 'image/jpeg' })) : [] })
  }
  function position() {
    if (!('mediaSession' in navigator) || !audio.duration || !isFinite(audio.duration)) return
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }) } catch {}
  }
  async function requestUrl(event, fallback) {
    try {
      return await getUrl(event, fallback ? FALLBACK_QUERY : {})
    } catch (err) {
      if (!fallback) {
        try { return await getUrl(event, FALLBACK_QUERY) } catch { /* prefer the original error */ }
      }
      throw err
    }
  }
  function seekWhenReady(at) {
    if (!at) return
    const seek = () => {
      const end = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : at
      try { audio.currentTime = Math.min(Math.max(0, at), end) } catch {}
    }
    if (audio.readyState >= 1) seek()
    else audio.addEventListener('loadedmetadata', seek, { once: true })
  }
  async function load(event, { autoplay = true, at = 0, fallback = false } = {}) {
    if (state.offline) {
      state.event = event; state.answer = null; state.error = ''; state.loading = false; state.pendingFade = 0
      audio.muted = false
      applyGain(1)
      render()
      return { ok: false, error: PLAYER_LINES[state.offline] || PLAYER_LINES.offline, reason: state.offline, trial: false }
    }
    const gen = ++state.gen
    state.event = event; state.answer = null; state.error = ''; state.loading = true; state.retried = fallback
    audio.pause(); audio.removeAttribute('src'); audio.load()
    mini.title.textContent = event.name; mini.artist.textContent = event.artists || ''
    mini.cover.replaceChildren(); const art = coverFor(event); if (art) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = art(96); mini.cover.append(img) }
    render(); session()
    try {
      const answer = await requestUrl(event, fallback)
      if (gen !== state.gen) return
      state.answer = answer
      if (!answer.url) { state.pendingFade = 0; audio.muted = false; applyGain(1); state.loading = false; render(); return status() }
      // A FLAC / hi-res URL that this browser is unlikely to decode: skip straight to standard MP3.
      if (!fallback && HARD_TYPES.has(answer.type) && typeof Audio !== 'undefined') {
        const probe = document.createElement?.('audio')
        const can = probe?.canPlayType?.(`audio/${answer.type}`) || ''
        if (!can) return load(event, { autoplay, at, fallback: true })
      }
      audio.src = answer.url
      seekWhenReady(at)
      if (state.pendingFade) { applyGain(0); audio.muted = true }
      if (autoplay) await audio.play()
      if (state.pendingFade) {
        const fade = state.pendingFade
        state.pendingFade = 0
        audio.muted = false
        fadeGain(1, fade)
      } else {
        audio.muted = false
        applyGain(1)
      }
    } catch (err) {
      if (gen !== state.gen) return status()
      if (err?.name === 'AbortError') return status()
      if (err?.name === 'NotAllowedError') { state.pendingFade = 0; audio.muted = false; state.error = ''; state.loading = false; render(); return status() }
      if (!fallback) return load(event, { autoplay, at, fallback: true })
      state.error = playErrorMessage(err, audio.error) || PLAYER_LINES.failed
    }
    if (gen !== state.gen) return status()
    state.loading = false
    render()
    return status()
  }
  function toggle() {
    if (!isCurrent()) return state.shown && load(state.shown)
    if (!state.answer?.url) return load(state.event)
    if (audio.paused) audio.play().catch(err => {
      if (err?.name === 'AbortError') return
      if (!state.retried) { load(state.event, { at: audio.currentTime || 0, fallback: true }); return }
      state.error = playErrorMessage(err, audio.error) || PLAYER_LINES.failed; render()
    })
    else audio.pause()
  }
  // Signed URLs expire; a decode / host failure should ask for a different quality once, not reuse the same URL.
  audio.addEventListener('error', () => {
    if (!state.event || !state.answer?.url) return
    if (state.loading && !audio.src) return
    if (!state.retried) { const at = audio.currentTime || 0; load(state.event, { at, fallback: true }); return }
    state.error = playErrorMessage({ name: audio.error?.code === 4 ? 'NotSupportedError' : 'Error' }, audio.error) || PLAYER_LINES.failed
    state.loading = false; render()
  })
  for (const type of ['play', 'pause', 'timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'waiting', 'playing']) audio.addEventListener(type, () => {
    if (type === 'waiting') state.loading = true
    if (type === 'playing') { state.loading = false; state.error = '' }
    render()
    if (type === 'durationchange' || type === 'play') position()
    if ('mediaSession' in navigator && (type === 'play' || type === 'pause')) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
  })
  audio.addEventListener('ended', () => onEnded(state.event))
  els.play.addEventListener('click', toggle)
  mini.play.addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()))
  mini.open.addEventListener('click', () => state.event && onOpen(state.event))
  mini.close.addEventListener('click', () => { audio.pause(); state.event = null; state.answer = null; render() })
  els.seek.addEventListener('input', () => { state.seeking = true; const d = audio.duration || 0; els.scrub.style.setProperty('--pos', els.seek.value / 1000); els.cur.textContent = fmt(d * els.seek.value / 1000) })
  els.seek.addEventListener('change', () => { state.seeking = false; if (audio.duration) audio.currentTime = audio.duration * els.seek.value / 1000; render() })
  if (els.volume) {
    let v = 1; try { v = Number(localStorage.getItem('chuting-volume') ?? 1) } catch {}
    state.userVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    els.volume.value = String(state.userVolume)
    applyGain(1)
    els.volume.style.setProperty('--vol', state.userVolume)
    els.volume.addEventListener('input', () => {
      state.userVolume = Number(els.volume.value)
      applyGain(state.gain)
      els.volume.style.setProperty('--vol', state.userVolume)
      try { localStorage.setItem('chuting-volume', String(state.userVolume)) } catch {}
    })
  }
  if ('mediaSession' in navigator) {
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn) } catch {} }
    set('play', () => audio.play()); set('pause', () => audio.pause())
    set('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; position() })
    set('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); position() })
    set('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); position() })
  }
  return {
    // The dialog shows a song; if something is playing and the user steps prev/next, the new song follows.
    show(event, { follow = false } = {}) {
      state.shown = event
      if (follow && state.event && !audio.paused && state.event.song_id !== event.song_id) load(event)
      else render()
    },
    get current() { return state.event },
    get playing() { return Boolean(state.event) && !audio.paused },
    play(event, opts = {}) {
      state.shown = state.shown || event
      if (opts.fadeIn) {
        state.pendingFade = typeof opts.fadeIn === 'number' ? opts.fadeIn : 1500
        applyGain(0)
        audio.muted = true
      }
      return load(event, { autoplay: opts.autoplay !== false, at: opts.at || 0 })
    },
    unlock() {
      try {
        audio.muted = true
        if (!audio.getAttribute('src')) audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
        const p = audio.play()
        if (p && p.catch) p.catch(() => {})
      } catch {}
    },
    duck(ms = 280) { return fadeGain(0, ms) },
    get note() {
      if (state.offline) return PLAYER_LINES[state.offline] || PLAYER_LINES.offline
      if (state.error) return state.error
      if (state.answer && !state.answer.url) return PLAYER_LINES[state.answer.reason] || PLAYER_LINES.unavailable
      return ''
    },
    setActions(prev, next) {
      if (!('mediaSession' in navigator)) return
      try { navigator.mediaSession.setActionHandler('previoustrack', prev); navigator.mediaSession.setActionHandler('nexttrack', next) } catch {}
    },
    setOffline(reason) { state.offline = reason || null; render() }, // null | 'offline' | 'login'
    render
  }
}
