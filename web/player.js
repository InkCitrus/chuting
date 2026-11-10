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
export const PLAY_QUERY = { encodeType: 'mp3' }
export const FALLBACK_QUERY = { level: 'standard', encodeType: 'mp3' }
export const HARD_TYPES = new Set(['flac', 'wav', 'ape', 'aiff', 'dsf', 'dff', 'alac', 'wma'])
const HARD_LEVELS = new Set(['lossless', 'hires', 'jyeffect', 'sky', 'jymaster', 'dolby'])
const SIMPLE_LOSSY = new Set(['mp3', 'aac', 'ogg', 'opus'])
const IMMERSIVE = new Set(['jyeffect', 'sky', 'jymaster', 'dolby'])
// Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) also fires for 403/404/HTML, an empty body, or a fee wall.
// The format line is only honest when the file itself is a hard type the browser did not decode.
export function audioKind(answer) {
  if (!answer) return ''
  const type = String(answer.type || '').toLowerCase()
  const encode = String(answer.encodeType || '').toLowerCase()
  const format = String(answer.format || '').toLowerCase()
  let ext = ''
  try {
    const path = new URL(answer.url || '', 'https://music.126.net').pathname.toLowerCase()
    ext = (path.match(/\.([a-z0-9]{2,5})$/) || [])[1] || ''
  } catch {}
  return format || encode || type || ext
}
export function hardAnswer(answer) {
  if (!answer?.url) return false
  const type = String(answer.type || answer.encodeType || '').toLowerCase()
  const encode = String(answer.encodeType || '').toLowerCase()
  const level = String(answer.level || '').toLowerCase()
  const kind = audioKind(answer)
  const br = Number(answer.br) || 0
  if (SIMPLE_LOSSY.has(type) || SIMPLE_LOSSY.has(kind)) return false
  if (HARD_TYPES.has(type) || HARD_TYPES.has(encode) || HARD_TYPES.has(kind)) return true
  const boxed = type === 'm4a' || type === 'mp4' || kind === 'm4a' || kind === 'mp4'
  if (boxed && (encode === 'alac' || IMMERSIVE.has(level) || (['lossless', 'hires'].includes(level) && br > 320000))) return true
  if (boxed && encode !== 'alac' && !IMMERSIVE.has(level)) return false
  if (HARD_LEVELS.has(level)) return true
  return br > 320000 && Boolean(type) && !SIMPLE_LOSSY.has(type) && type !== 'm4a'
}
const FORMAT_LABEL = {
  flac: 'FLAC', ape: 'APE', wav: 'WAV', aiff: 'AIFF', aif: 'AIFF', dsf: 'DSF', dff: 'DFF',
  alac: 'ALAC', wma: 'WMA', dolby: '杜比全景声', jymaster: '超清母带', sky: '沉浸环绕声', jyeffect: '高清臻音'
}
export function formatLabel(type) {
  const key = String(type || '').toLowerCase().replace(/^\./, '')
  if (FORMAT_LABEL[key]) return FORMAT_LABEL[key]
  return /^[a-z0-9]{2,8}$/.test(key) ? key.toUpperCase() : ''
}
export function cloudUnplayableMessage(answer) {
  const label = formatLabel(answer?.format || audioKind(answer))
  return label ? `网盘里这首是 ${label} 格式，浏览器放不了` : '网盘里这首的格式，浏览器放不了'
}
function probeCanPlay(mime) {
  try { return Boolean(document.createElement('audio').canPlayType(mime)) } catch { return false }
}
export function browserCanPlay(answer, probe = probeCanPlay) {
  if (!answer?.url) return false
  if (!hardAnswer(answer)) return true
  return audioKind(answer) === 'flac' && Boolean(probe('audio/flac') || probe('audio/x-flac'))
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
  if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return null
  if (answer && !answer.url) return PLAYER_LINES[answer.reason] || PLAYER_LINES.unavailable
  if (answer?.reason === 'rights' || answer?.reason === 'copyright') return PLAYER_LINES[answer.reason]
  if (answer?.trial) return PLAYER_LINES.rights
  if (hardAnswer(answer)) return answer.cloud ? cloudUnplayableMessage(answer) : PLAYER_LINES.unsupported
  return PLAYER_LINES.failed
}

// A tiny silent clip. play() on it runs inside the tap that asked for a song:
// it stops the previous track at once and unlocks the element on iOS WebKit
// (Safari and Chrome on iPhone), so the real src may play after the network wait.
export const PRIME_SRC = 'data:audio/wav;base64,UklGRgQCAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YeABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA='

// 音量均衡. NetEase returns a per-file ReplayGain-style `gain` (dB, usually -10…-4 for modern masters) and a
// linear `peak`. Every track is brought to about -14 LUFS (gain + 4 dB, the level most streaming apps use).
// It only ever turns a track down: a quiet track would need boosting past its peak, which would clip.
export const LOUDNESS_PREAMP_DB = 4
export const LOUDNESS_FLOOR_DB = -12
// A file NetEase has not measured (gain missing or 0) gets the typical correction, so it does not jump
// out ~4 dB louder than its measured neighbours.
export const LOUDNESS_UNKNOWN_DB = -3
export function loudnessDb(answer, preamp = LOUDNESS_PREAMP_DB) {
  const gain = Number(answer?.gain)
  if (!Number.isFinite(gain) || gain === 0) return LOUDNESS_UNKNOWN_DB
  const peak = Number(answer?.peak)
  const headroom = Number.isFinite(peak) && peak > 0 ? Math.min(0, -20 * Math.log10(peak)) : 0
  return Math.max(LOUDNESS_FLOOR_DB, Math.min(headroom, gain + preamp)) + 0 // + 0: never -0
}
export function loudnessFactor(answer, preamp) { return 10 ** (loudnessDb(answer, preamp) / 20) }
// iOS WebKit (Safari and Chrome on iPhone) ignores HTMLMediaElement.volume: setting it reads back as 1.
// There 音量均衡 would need Web Audio, which stops playback when the screen locks, so it is not used.
export function volumeAdjustable(make = () => new Audio()) {
  try { const a = make(); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01 } catch { return false }
}

export function createPlayer({ els, mini, getUrl, coverFor, onEnded, onOpen, onChange, onUnplayable }) {
  const audio = new Audio()
  audio.preload = 'auto'
  audio.playsInline = true
  try { audio.setAttribute('playsinline', '') } catch {}
  const state = { event: null, answer: null, shown: null, error: '', loading: false, retried: false, failed: false, blocked: false, offline: false, seeking: false, replacing: false, gen: 0, hosts: [], hostIndex: 0, gain: 1, userVolume: 1, pendingFade: 0, norm: 1, normalize: false }
  let fadeRaf = 0
  let mediaEpoch = 0
  let recovery = null
  let lastJob = null
  function applyGain(g) {
    state.gain = Math.min(1, Math.max(0, g))
    audio.volume = Math.min(1, Math.max(0, state.userVolume * state.gain * state.norm))
  }
  // Loudness for the current answer; a change mid-song glides over ~400ms instead of jumping.
  let normRaf = 0
  function setNorm(to, ms = 0) {
    cancelAnimationFrame(normRaf)
    if (!ms || typeof requestAnimationFrame !== 'function') { state.norm = to; applyGain(state.gain); return }
    const from = state.norm, start = performance.now()
    const step = now => {
      const t = Math.min(1, (now - start) / ms)
      state.norm = from + (to - from) * t; applyGain(state.gain)
      if (t < 1) normRaf = requestAnimationFrame(step)
    }
    normRaf = requestAnimationFrame(step)
  }
  const normFor = answer => state.normalize ? loudnessFactor(answer) : 1
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
      song_id: state.event?.song_id ?? null,
      ok: Boolean(state.answer?.url) && !state.error && !state.blocked,
      error: state.error || '',
      reason: state.blocked ? 'blocked' : (state.answer?.reason || (state.error ? 'failed' : '')),
      blocked: Boolean(state.blocked),
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
  const isPrime = () => String(audio.src || '').startsWith('data:')
  function transportPlaying() { return Boolean(state.event) && !state.failed && !state.error && !audio.paused && !isPrime() }
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
  // The listener asked for a different song: silence the old one now, so the
  // arrival page / mini bar never show one song while another is still heard.
  function prime() {
    mediaEpoch++
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fadeRaf)
    try { audio.pause() } catch {}
    audio.muted = false
    try {
      audio.src = PRIME_SRC
      const p = audio.play()
      if (p && p.catch) p.catch(() => {})
    } catch {}
  }
  function noteUnplayable(event, result) {
    try { onUnplayable?.(event, result) } catch {}
    return result
  }
  async function requestUrl(event, fallback, gen) {
    try {
      return await getUrl(event, fallback ? FALLBACK_QUERY : PLAY_QUERY)
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
  function markBlocked() {
    state.blocked = true
    state.failed = false
    state.error = ''
    state.loading = false
    state.replacing = false
    state.pendingFade = 0
    audio.muted = false
    applyGain(1)
    render()
    return status()
  }
  function finish(gen, err) {
    if (gen !== state.gen) return stale()
    if (err?.name === 'NotAllowedError') return markBlocked()
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
    if (!fallback) prime()
    adopt(event); state.answer = null; state.error = ''; state.failed = false; state.blocked = false; state.loading = true; state.retried = Boolean(fallback)
    // The old track is already stopped (prime); ignore its leftover media events.
    state.replacing = true
    mini.title.textContent = event.name; mini.artist.textContent = event.artists || ''
    mini.cover.replaceChildren(); const art = coverFor(event); if (art) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = art(96); mini.cover.append(img) }
    render(); session()
    let firstSrc = ''
    try {
      const answer = await requestUrl(event, fallback, gen)
      if (gen !== state.gen) return stale()
      state.answer = answer
      setNorm(normFor(answer))
      if (!answer.url) {
        state.pendingFade = 0; audio.muted = false; applyGain(1); state.loading = false; state.failed = true
        clearSrc()
        render(); return noteUnplayable(event, status())
      }
      // Prefer a lower-level MP3 before asking the browser to decode FLAC / hi-res.
      // After that retry, FLAC may play if canPlayType agrees; ape / ALAC / Dolby still will not.
      if (hardAnswer(answer) && !(state.retried && browserCanPlay(answer))) {
        return state.retried ? finish(gen, { name: 'Error' }) : settle(gen, { name: 'Error' })
      }
      state.hosts = audioHosts(answer.url); state.hostIndex = 0
      mediaEpoch++
      audio.src = state.hosts[0]
      firstSrc = audio.src
      seekWhenReady(at)
      // Fade with volume only. A muted play() is allowed without a gesture on iOS,
      // but WebKit pauses it again the moment it is unmuted, while we would
      // report success: silent, with no tap-to-play hint.
      audio.muted = false
      if (state.pendingFade) applyGain(0)
      if (autoplay) {
        await audio.play()
        if (gen !== state.gen) return stale()
        if (audio.paused) return markBlocked()
      }
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
      if (err?.name === 'NotAllowedError' && gen === state.gen) return markBlocked()
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
      if (err?.name === 'NotAllowedError') { markBlocked(); return }
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
      if (err?.name === 'NotAllowedError') return markBlocked()
      if (err?.name === 'AbortError' || audio.src !== src) return recovery || status()
      return settle(gen, err)
    })
    recovery = job
    return job
  }
  // A host failure tries the twin edge first; a decode failure then asks for a lower level once. Errors from an older src are ignored,
  // so a slow song cannot stamp an error onto the one the listener just opened.
  audio.addEventListener('error', () => {
    if (isPrime()) return
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
    if (isPrime()) return
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
    if (isPrime()) return
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
      if (opts.fadeIn) state.pendingFade = typeof opts.fadeIn === 'number' ? opts.fadeIn : 1500
      const job = load(event, { autoplay: opts.autoplay !== false, at: opts.at || 0 })
      lastJob = job
      return job
    },
    // The newest play() promise, so callers that did not start it (auto-skip,
    // end of song) can still wait for the result of the track now loading.
    get job() { return lastJob },
    // A tap on a blocked track. If its URL is already on the element, play()
    // runs right here inside the gesture: no network wait, so iOS allows it.
    resume(event) {
      if (event && state.event?.song_id === event.song_id && state.blocked && state.answer?.url && audio.src && !isPrime()) {
        state.blocked = false
        const job = Promise.resolve(audio.play()).then(() => {
          state.replacing = false; state.loading = false; audio.muted = false; applyGain(1); render(); return status()
        }, err => err?.name === 'NotAllowedError' ? markBlocked() : settle(state.gen, err))
        lastJob = job
        return job
      }
      return this.play(event || state.event)
    },
    unlock() {
      try {
        audio.playsInline = true
        try { audio.setAttribute('playsinline', '') } catch {}
        const src = (audio.getAttribute && audio.getAttribute('src')) || audio.src || ''
        // A dummy silent clip consumes the user gesture and ends immediately.
        // Only prime an element that already has a real source.
        if (!src || src.startsWith('data:')) return
        audio.muted = true
        const p = audio.play()
        if (p && p.catch) p.catch(() => {})
      } catch {}
    },
    duck(ms = 280) { return fadeGain(0, ms) },
    // 音量均衡 on/off; the playing song glides to its new level.
    setNormalize(on) {
      state.normalize = Boolean(on)
      setNorm(state.answer?.url ? normFor(state.answer) : 1, audio.paused ? 0 : 400)
    },
    get loudness() { return { on: state.normalize, factor: state.norm, db: state.normalize && state.answer ? loudnessDb(state.answer) : 0 } },
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
