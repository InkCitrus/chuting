import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayer, PLAYER_LINES, FALLBACK_QUERY, playErrorMessage } from '../web/player.js'

class FakeAudio extends EventTarget {
  constructor() {
    super()
    this.paused = true
    this.currentTime = 0
    this.duration = NaN
    this.src = ''
    this.volume = 1
    this.playbackRate = 1
    this.readyState = 0
    this.error = null
    this.buffered = { length: 0 }
    this._fail = null
  }
  play() {
    if (this._fail) {
      const err = Object.assign(new Error(this._fail), { name: this._fail })
      return Promise.reject(err)
    }
    if (this.src.includes('bad-flac') || this.src.includes('bad-host')) {
      // Browsers clear `paused` as soon as play() is called, then reject when the bytes are unusable.
      this.paused = false
      this.error = { code: 4 }
      this.dispatchEvent(new Event('play'))
      const err = Object.assign(new Error('failed'), { name: 'NotSupportedError' })
      queueMicrotask(() => this.dispatchEvent(new Event('error')))
      return Promise.reject(err)
    }
    this.paused = false
    this.duration = 180
    this.readyState = 4
    this.dispatchEvent(new Event('loadedmetadata'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  load() {
    // An empty element reports code 4. Browsers do this while src is still blank; a later song must not inherit it.
    if (!this.src) {
      this.error = { code: 4 }
      this.dispatchEvent(new Event('error'))
    }
  }
  removeAttribute(name) { if (name === 'src') this.src = '' }
}

function classes() {
  const on = new Set()
  return {
    toggle(name, force) {
      const next = force === undefined ? !on.has(name) : Boolean(force)
      if (next) on.add(name)
      else on.delete(name)
      return next
    },
    has: name => on.has(name)
  }
}

function mount() {
  const note = { textContent: '', hidden: true }
  const rootClasses = classes()
  const dialogClasses = classes()
  const root = { classList: rootClasses }
  const dialog = { open: false, classList: dialogClasses }
  const play = { disabled: false, label: '', setAttribute(key, value) { if (key === 'aria-label') this.label = value }, addEventListener() {} }
  const seek = { value: '0', disabled: false, addEventListener() {} }
  const scrub = { style: { setProperty() {} } }
  const cur = { textContent: '0:00' }, dur = { textContent: '0:00' }
  const volume = { value: 1, style: { setProperty() {} }, addEventListener() {} }
  const miniClasses = classes()
  const mini = {
    root: { hidden: true, classList: miniClasses, style: { setProperty() {} } },
    play: { label: '', setAttribute(key, value) { if (key === 'aria-label') this.label = value }, addEventListener() {} },
    open: { addEventListener() {} },
    close: { addEventListener() {} },
    title: { textContent: '' }, artist: { textContent: '' },
    cover: { replaceChildren() {}, append() {} }
  }
  return { els: { root, dialog, play, seek, scrub, cur, dur, note, volume }, mini, note, rootClasses, dialogClasses }
}

function install(canPlay = '') {
  const Original = globalThis.Audio
  let audio = null
  globalThis.Audio = class extends FakeAudio {
    constructor() { super(); audio = this }
  }
  globalThis.document = { body: { classList: { toggle() {} } }, createElement: () => ({ canPlayType: () => canPlay }) }
  return {
    audio: () => audio,
    restore() { globalThis.Audio = Original }
  }
}

test('playErrorMessage does not call every code-4 failure a format problem', () => {
  assert.equal(playErrorMessage({ name: 'NotAllowedError' }), '')
  assert.equal(playErrorMessage({ name: 'AbortError' }), null)
  assert.equal(playErrorMessage({ name: 'NotSupportedError' }, { code: 4 }, { url: 'https://m801.music.126.net/a.mp3', type: 'mp3' }), PLAYER_LINES.failed)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/a.flac', type: 'flac' }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/a.flac', level: 'hires' }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'rights' }), PLAYER_LINES.rights)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'copyright' }), PLAYER_LINES.copyright)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'unavailable' }), PLAYER_LINES.unavailable)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/clip.mp3', type: 'mp3', trial: { start: 0, end: 30 } }), PLAYER_LINES.rights)
  assert.equal(playErrorMessage({ name: 'Error' }), PLAYER_LINES.failed)
  assert.deepEqual(FALLBACK_QUERY, { level: 'standard', encodeType: 'mp3' })
})

test('a FLAC URL falls back to standard mp3 even if the browser claims it can play flac', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push(query)
        if (query.level === 'standard') return { url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', duration: 368000 }
        return { url: 'https://m801.music.126.net/bad-flac.flac', type: 'flac', duration: 368000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    await new Promise(r => setTimeout(r, 40))
    assert.deepEqual(queries[0], {})
    assert.equal(queries.length, 2)
    assert.deepEqual(queries[1], FALLBACK_QUERY)
    assert.equal(env.audio().src, 'https://m801.music.126.net/ok.mp3')
    assert.equal(note.textContent.includes('没放出来') || note.textContent.includes('格式'), false)
    assert.equal(player.playing, true)
    assert.equal(els.play.label, '暂停')
  } finally {
    env.restore()
  }
})

test('a first getUrl failure retries at standard mp3 before showing an error', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push(query)
        if (!query.level) throw new Error('upstream')
        return { url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', duration: 180000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '1', name: 'ok', artists: 'a' })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(queries.some(q => q.level === 'standard'))
    assert.notEqual(note.textContent, PLAYER_LINES.failed)
  } finally {
    env.restore()
  }
})

test('a code-4 failure on mp3 retries once, then the button returns to play', async () => {
  const env = install('probably')
  try {
    const { els, mini, note, rootClasses, dialogClasses } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push({ ...query })
        return { url: 'https://m801.music.126.net/bad-host.mp3', type: 'mp3', br: 320000, duration: 368000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(queries.length, 2)
    assert.deepEqual(queries[0], {})
    assert.deepEqual(queries[1], FALLBACK_QUERY)
    assert.equal(note.textContent, PLAYER_LINES.failed)
    assert.equal(note.textContent.includes('格式'), false)
    assert.equal(els.play.label, '播放')
    assert.equal(els.play.disabled, false)
    assert.equal(player.playing, false)
    assert.equal(env.audio().paused, true)
    assert.equal(rootClasses.has('is-playing'), false)
    assert.equal(dialogClasses.has('is-playing'), false)
    assert.equal(els.cur.textContent, '0:00')
    assert.equal(els.dur.textContent, '6:08')
    assert.equal(els.seek.value, '0')
  } finally {
    env.restore()
  }
})

test('a FLAC file that is still FLAC at the lower level says so, and does not ask a third time', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push(query.level || 'first')
        return { url: 'https://m801.music.126.net/bad-flac.flac', type: 'flac', duration: 368000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(queries, ['first', 'standard'])
    assert.equal(note.textContent, PLAYER_LINES.unsupported)
    assert.equal(els.play.label, '播放')
    assert.equal(player.playing, false)
    assert.equal(env.audio().paused, true)
  } finally {
    env.restore()
  }
})

test('a null or trial answer uses the membership or copyright line', async () => {
  const env = install()
  try {
    const { els, mini, note } = mount()
    const player = createPlayer({
      els, mini,
      getUrl: async () => ({ url: null, reason: 'rights' }),
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    assert.equal(note.textContent, PLAYER_LINES.rights)
    assert.equal(els.play.label, '播放')
    assert.equal(player.playing, false)

    const copyright = createPlayer({
      els, mini,
      getUrl: async () => ({ url: null, reason: 'copyright' }),
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await copyright.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    assert.equal(note.textContent, PLAYER_LINES.copyright)
    assert.equal(els.play.label, '播放')
  } finally {
    env.restore()
  }
})

test('a trial clip that cannot be decoded is a membership limit, not a format error', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    let calls = 0
    const player = createPlayer({
      els, mini,
      getUrl: async () => {
        calls++
        return { url: 'https://m801.music.126.net/bad-host.mp3', type: 'mp3', trial: { start: 0, end: 30 }, duration: 30000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(calls, 2)
    assert.equal(note.textContent, PLAYER_LINES.rights)
    assert.equal(els.play.label, '播放')
    assert.equal(player.playing, false)
  } finally {
    env.restore()
  }
})

test('a slower song cannot overwrite the one that started after it', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const player = createPlayer({
      els, mini,
      getUrl: async event => {
        if (event.song_id === 'old') {
          await gate
          return { url: 'https://m801.music.126.net/bad-flac.flac', type: 'flac', duration: 180000 }
        }
        return { url: 'https://m801.music.126.net/new.mp3', type: 'mp3', duration: 180000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    const first = player.play({ song_id: 'old', name: '旧的' })
    const second = player.play({ song_id: 'new', name: '新的' })
    release()
    await first
    await second
    await new Promise(r => setTimeout(r, 30))
    assert.equal(env.audio().src, 'https://m801.music.126.net/new.mp3')
    assert.equal(player.current.song_id, 'new')
    assert.equal(player.playing, true)
    assert.equal(note.textContent.includes('格式') || note.textContent.includes('没放出来'), false)
  } finally {
    env.restore()
  }
})
