// Song player: one <audio>, a dialog control row, a mini bar that stays after the dialog closes, and Media
// Session for lock-screen / OS controls. The playable URL is asked for only when play is pressed (one worker
// call, the account's own rights). Audio streams straight from NetEase's CDN and is never cached.
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
export const PLAYER_LINES = {
  rights: '这首得开会员或单独买才能听。',
  copyright: '这首有版权限制，这边放不了。',
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
const HARD_LEVELS = new Set(['lossless', 'hires', 'jyeffect', 'sky', 'jymaster'])
const LOSSY_TYPES = new Set(['mp3', 'aac', 'm4a'])
// Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) also fires for 403/404/HTML, an empty body, or a fee wall.
// The format line is only honest when the file itself is a hard type the browser did not decode.
export function hardAnswer(answer) {
  if (!answer?.url) return false
  const type = String(answer.type || '').toLowerCase()
  if (HARD_TYPES.has(type)) return true
  if (HARD_LEVELS.has(String(answer.level || '').toLowerCase())) return true
  return Number(answer.br) > 320000 && Boolean(type) && !LOSSY_TYPES.has(type)
}
// NetEase serves each file from one storage zone, reachable as m7 or m701 (m8 or m801, …). The wrong
// one answers 400 OperationZoneMismatch. The host NetEase gave is tried first, its twin only after a media error.
export function audioHosts(url) {
  try {
    const first = new URL(url)
    const m = first.hostname.match(/^m(\d+?)(01)?\.music\.126\.net$/)
    if (!m) return [url]
    const twin = new URL(url)
    twin.hostname = `m${m[1]}${m[2] ? '' : '01'}.music.126.net`
    return [url, twin.toString()]
  } catch { return [url] }
}
export function playErrorMessage(err, _mediaError, answer) {
  if (err?.name === 'NotAllowedError') return ''
  if (err?.name === 'AbortError') return null
  if (answer && !answer.url) return PLAYER_LINES[answer.reason] || PLAYER_LINES.unavailable
  if (answer?.reason === 'rights' || answer?.reason === 'copyright') return PLAYER_LINES[answer.reason]
  if (answer?.trial) return PLAYER_LINES.rights
  if (hardAnswer(answer)) return PLAYER_LINES.unsupported
  return PLAYER_LINES.failed
}

export function createPlayer({ els, mini, getUrl, coverFor, onEnded, onOpen, onChange, onUnplayable }) {
  const audio = new Audio()
  audio.preload = 'auto'
  const state = { event: null, answer: null, shown: null, error: '', loading: false, retried: false, failed: false, offline: false, seeking: false, replacing: false, gen: 0, hosts: [], hostIndex: 0, gain: 1, userVolume: 1, pendingFade: 0 }
  let fadeRaf = 0
  let mediaEpoch = 0
  let recovery = null
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

  function clock() {
    const reported = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
    const fromAnswer = (Number(state.answer?.duration) || 0) / 1000
    const dur = reported || (fromAnswer > 0 ? fromAnswer : 0)
    let pos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    if (dur) pos = Math.min(Math.max(0, pos), dur)
    else pos = 0
    return { dur, pos }
  }
  function transportPlaying() { return Boolean(state.event) && !state.failed && !state.error && !audio.paused }
  function render() {
    const current = isCurrent(), playing = current && transportPlaying()
    const unavailable = current && state.answer && !state.answer.url
    const { dur: liveDur, pos: livePos } = clock()
    const dur = current ? liveDur : 0
    const pos = current ? livePos : 0
    els.root.classList.toggle('is-playing', playing)
    els.root.classList.toggle('is-loading', current && state.loading)
    els.root.classList.toggle('is-off', Boolean(state.offline && !current) || Boolean(unavailable))
    els.dialog.classList.toggle('is-playing', playing)
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放')
    els.play.disabled = Boolean(state.offline && !current) || Boolean(unavailable)
    if (!state.seeking) els.seek.value = dur ? String(Math.round(pos / dur * 1000)) : '0'
    els.seek.disabled = !current || !dur || Boolean(state.error)
    let buf = 0
    if (current && dur && audio.buffered) for (let i = 0; i < audio.buffered.length; i++) if (audio.buffered.start(i) <= pos + .5) buf = Math.max(buf, audio.buffered.end(i))
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
      const miniPlaying = transportPlaying()
      mini.root.classList.toggle('is-playing', miniPlaying)
      mini.play.setAttribute('aria-label', miniPlaying ? '暂停' : '播放')
      mini.root.style.setProperty('--pos', liveDur ? (livePos / liveDur).toFixed(4) : 0)
    }
    if (mini.root.dataset) {
      mini.root.dataset.playingId = state.event?.song_id != null ? String(state.event.song_id) : ''
      const src = audio.currentSrc || audio.src || ''
      mini.root.dataset.audioSrc = src && !src.startsWith('data:') ? src : ''
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
  function stale() { return { ok: false, error: '', reason: '', trial: false } }
  function adopt(event) {
    const prev = state.event
    state.event = event
    if (event && event.song_id !== prev?.song_id) {
      try { onChange?.(event) } catch {}
    }
  }
  function clearSrc() {
    mediaEpoch++
    state.replacing = true
    try { audio.pause() } catch {}
    audio.removeAttribute('src')
    // Do not call audio.load() on an empty element: on iOS / mobile Chrome
    // that drops the user-gesture unlock and can fire a spurious `ended`.
  }
  function noteUnplayable(event, result) {
    try { onUnplayable?.(event, result) } catch {}
    return result
  }
  async function requestUrl(event, fallback, gen) {
    try {
      return await getUrl(event, fallback ? FALLBACK_QUERY : {})
    } catch (err) {
      if (!fallback && gen === state.gen) {
        try {
          const answer = await getUrl(event, FALLBACK_QUERY)
          if (gen === state.gen) state.retried = true
          return answer
        } catch { /* prefer the original error */ }
      }
      throw err
    }
  }
  function finish(gen, err) {
    if (gen !== state.gen) return stale()
    const message = playErrorMessage(err, audio.error, state.answer)
    if (message == null) return status()
    state.failed = true
    state.error = message || PLAYER_LINES.failed
    state.loading = false
    state.pendingFade = 0
    audio.muted = false
    applyGain(1)
    try { audio.pause() } catch {}
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'paused' } catch {}
    }
    render()
    return noteUnplayable(state.event, status())
  }
  function settle(gen, err) {
    if (gen !== state.gen) return recovery || stale()
    if (!state.retried) {
      const at = Number.isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : 0
      const job = load(state.event, { autoplay: true, at, fallback: true })
      recovery = job
      return job
    }
    return finish(gen, err)
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
    if (!fallback) recovery = null
    if (state.offline) {
      state.gen++
      adopt(event); state.answer = null; state.error = ''; state.failed = false; state.loading = false; state.pendingFade = 0
      mini.title.textContent = event.name; mini.artist.textContent = event.artists || ''
      audio.muted = false
      applyGain(1)
      clearSrc()
      render()
      return { ok: false, error: PLAYER_LINES[state.offline] || PLAYER_LINES.offline, reason: state.offline, trial: false }
    }
    const gen = ++state.gen
    adopt(event); state.answer = null; state.error = ''; state.failed = false; state.loading = true; state.retried = Boolean(fallback)
    // Keep any muted/primed playback alive until the new URL arrives so a
    // play() started in a tap gesture still counts after the network wait.
    state.replacing = true
    mini.title.textContent = event.name; mini.artist.textContent = event.artists || ''
    mini.cover.replaceChildren(); const art = coverFor(event); if (art) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = art(96); mini.cover.append(img) }
    render(); session()
    let firstSrc = ''
    try {
      const answer = await requestUrl(event, fallback, gen)
      if (gen !== state.gen) return stale()
      state.answer = answer
      if (!answer.url) {
        state.pendingFade = 0; audio.muted = false; applyGain(1); state.loading = false; state.failed = true
        clearSrc()
        render(); return noteUnplayable(event, status())
      }
      // Skip FLAC / hi-res even when canPlayType says yes: 24-bit files and mislabeled 403s both surface as code 4.
      if (!state.retried && hardAnswer(answer)) return settle(gen, { name: 'Error' })
      state.hosts = audioHosts(answer.url); state.hostIndex = 0
      mediaEpoch++
      audio.src = state.hosts[0]
      firstSrc = audio.src
      seekWhenReady(at)
      if (state.pendingFade) { applyGain(0); audio.muted = true }
      if (autoplay) await audio.play()
      if (gen !== state.gen) return stale()
      state.replacing = false
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
      if (err?.name === 'NotAllowedError' && gen === state.gen) {
        state.pendingFade = 0; audio.muted = false; state.error = ''; state.failed = false; state.loading = false; state.replacing = false; render(); return status()
      }
      if (gen !== state.gen) return recovery || stale()
      if (err?.name === 'AbortError') return recovery || status()
      if (state.answer?.url && audio.src !== firstSrc) return recovery || status()
      if (state.answer?.url) { const job = nextHost(gen); if (job) return job }
      return settle(gen, err)
    }
    if (gen !== state.gen) return stale()
    state.loading = false
    state.replacing = false
    render()
    return status()
  }
  function toggle() {
    if (!isCurrent()) return state.shown && load(state.shown)
    if (!state.answer?.url || state.error || state.failed) return load(state.event)
    if (audio.paused) audio.play().catch(err => {
      if (err?.name === 'AbortError') return
      settle(state.gen, err)
    })
    else audio.pause()
  }
  // Same file on the other storage edge, from where it stopped. Returns null when there is none left.
  function nextHost(gen) {
    if (gen !== state.gen || state.hostIndex >= state.hosts.length - 1) return null
    state.hostIndex++
    const at = Number.isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : 0
    mediaEpoch++
    audio.src = state.hosts[state.hostIndex]
    const src = audio.src
    seekWhenReady(at)
    const job = audio.play().then(() => {
      if (gen !== state.gen) return stale()
      state.loading = false; audio.muted = false; applyGain(1); render()
    }).catch(err => {
      if (gen !== state.gen) return stale()
      if (err?.name === 'NotAllowedError') { state.loading = false; render(); return status() }
      if (err?.name === 'AbortError' || audio.src !== src) return recovery || status()
      return settle(gen, err)
    })
    recovery = job
    return job
  }
  // A host failure tries the twin edge first; a decode failure then asks for a lower level once. Errors from an older src are ignored,
  // so a slow song cannot stamp an error onto the one the listener just opened.
  audio.addEventListener('error', () => {
    const epoch = mediaEpoch
    const gen = state.gen
    const src = audio.src
    queueMicrotask(() => {
      if (epoch !== mediaEpoch || gen !== state.gen) return
      if (!src || audio.src !== src) return
      if (!state.event || !state.answer?.url) return
      nextHost(gen) || settle(gen, { name: 'Error' })
    })
  })
  for (const type of ['play', 'pause', 'timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'waiting', 'playing']) audio.addEventListener(type, () => {
    if (type === 'waiting') state.loading = true
    if (type === 'playing') {
      if (state.failed) { try { audio.pause() } catch {} ; return }
      state.loading = false; state.error = ''
    }
    render()
    if (type === 'durationchange' || type === 'play') position()
    if ('mediaSession' in navigator && (type === 'play' || type === 'pause')) navigator.mediaSession.playbackState = state.failed || audio.paused ? 'paused' : 'playing'
  })
  audio.addEventListener('ended', () => {
    if (state.loading || state.replacing || state.failed) return
    if (!state.event || !state.answer?.url) return
    onEnded(state.event)
  })
  els.play.addEventListener('click', toggle)
  mini.play.addEventListener('click', () => {
    if (!state.event) return
    if (!state.answer?.url || state.error || state.failed) { load(state.event); return }
    if (audio.paused) audio.play().catch(err => { if (err?.name !== 'AbortError') settle(state.gen, err) })
    else audio.pause()
  })
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
    get playing() { return transportPlaying() },
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
        const src = (audio.getAttribute && audio.getAttribute('src')) || audio.src
        if (!src) audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
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
