import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayer, PLAYER_LINES, PLAY_QUERY, FALLBACK_QUERY, playErrorMessage, audioHosts, hardAnswer, cloudUnplayableMessage, browserCanPlay } from '../web/player.js'

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
    if (this.src.includes('bad-flac') || this.src.includes('bad-host') || (this.src.includes('zone-miss') && this.src.includes('//m701.'))) {
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
  getAttribute(name) { return name === 'src' ? (this.src || null) : null }
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
    root: { hidden: true, classList: miniClasses, style: { setProperty() {} }, dataset: {} },
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
  assert.equal(playErrorMessage({ name: 'NotAllowedError' }), null)
  assert.equal(playErrorMessage({ name: 'AbortError' }), null)
  assert.equal(playErrorMessage({ name: 'NotSupportedError' }, { code: 4 }, { url: 'https://m801.music.126.net/a.mp3', type: 'mp3' }), PLAYER_LINES.failed)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/a.flac', type: 'flac' }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/a.flac', level: 'hires' }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/a.ape', type: 'ape', cloud: true, format: 'ape' }), '网盘里这首是 APE 格式，浏览器放不了')
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'rights' }), PLAYER_LINES.rights)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'copyright' }), PLAYER_LINES.copyright)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: null, reason: 'unavailable' }), PLAYER_LINES.unavailable)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }, { url: 'https://m801.music.126.net/clip.mp3', type: 'mp3', trial: { start: 0, end: 30 } }), PLAYER_LINES.rights)
  assert.equal(playErrorMessage({ name: 'Error' }), PLAYER_LINES.failed)
  assert.deepEqual(FALLBACK_QUERY, { level: 'standard', encodeType: 'mp3' })
  assert.deepEqual(PLAY_QUERY, { encodeType: 'mp3' })
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.mp3', type: 'mp3', level: 'lossless' }), false)
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.ape', type: 'ape' }), true)
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', level: 'exhigh', br: 256000 }), false)
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', encodeType: 'alac', level: 'lossless', br: 900000 }), true)
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', level: 'dolby', br: 768000 }), true)
  assert.equal(hardAnswer({ url: 'https://m801.music.126.net/a.bin', encodeType: 'flac' }), true)
  assert.equal(cloudUnplayableMessage({ cloud: true, format: 'ape' }), '网盘里这首是 APE 格式，浏览器放不了')
  assert.equal(cloudUnplayableMessage({ cloud: true, type: 'flac', url: 'https://m801.music.126.net/a.flac' }), '网盘里这首是 FLAC 格式，浏览器放不了')
  assert.equal(browserCanPlay({ url: 'https://m801.music.126.net/a.mp3', type: 'mp3' }), true)
  assert.equal(browserCanPlay({ url: 'https://m801.music.126.net/a.ape', type: 'ape' }), false)
  assert.equal(browserCanPlay({ url: 'https://m801.music.126.net/a.flac', type: 'flac' }, mime => mime.includes('flac') ? 'probably' : ''), true)
  assert.equal(browserCanPlay({ url: 'https://m801.music.126.net/a.flac', type: 'flac' }, () => ''), false)
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
    assert.deepEqual(queries[0], PLAY_QUERY)
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
    assert.deepEqual(queries[0], PLAY_QUERY)
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

test('audioHosts tries the given edge first, then its storage twin', () => {
  assert.deepEqual(audioHosts('https://m701.music.126.net/a/ymusic/x.mp3?v=1'), ['https://m701.music.126.net/a/ymusic/x.mp3?v=1', 'https://m7.music.126.net/a/ymusic/x.mp3?v=1'])
  assert.deepEqual(audioHosts('https://m8.music.126.net/x.mp3'), ['https://m8.music.126.net/x.mp3', 'https://m801.music.126.net/x.mp3'])
  assert.deepEqual(audioHosts('https://vodkgeyttp9.vod.126.net/obj/a.mp3'), ['https://vodkgeyttp9.vod.126.net/obj/a.mp3'])
  assert.deepEqual(audioHosts('not a url'), ['not a url'])
})

test('a zone miss on one edge plays from the twin edge without asking NetEase again', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push({ ...query })
        return { url: 'https://m701.music.126.net/2026/ymusic/zone-miss.mp3', type: 'mp3', br: 320000, duration: 152000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '1', name: 'Hold Me Now', artists: 'a' })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(queries.length, 1)
    assert.equal(env.audio().src, 'https://m7.music.126.net/2026/ymusic/zone-miss.mp3')
    assert.equal(player.playing, true)
    assert.notEqual(note.textContent, PLAYER_LINES.failed)
  } finally {
    env.restore()
  }
})

test('ended while the next song is loading does not skip, and onChange follows the new track', async () => {
  const env = install('probably')
  try {
    const { els, mini } = mount()
    let ended = 0
    const changes = []
    const player = createPlayer({
      els, mini,
      getUrl: async event => {
        if (event.song_id === 'b') await new Promise(r => setTimeout(r, 30))
        return { url: `https://m801.music.126.net/${event.song_id}.mp3`, type: 'mp3', duration: 180000 }
      },
      coverFor: () => null,
      onEnded() { ended++ },
      onChange(event) { changes.push(event.song_id) },
      onOpen() {}
    })
    await player.play({ song_id: 'a', name: '甲' })
    assert.deepEqual(changes, ['a'])
    env.audio().dispatchEvent(new Event('ended'))
    assert.equal(ended, 1)
    const next = player.play({ song_id: 'b', name: '乙' })
    env.audio().dispatchEvent(new Event('ended'))
    await next
    assert.equal(ended, 1)
    assert.deepEqual(changes, ['a', 'b'])
    assert.equal(player.current.song_id, 'b')
    assert.equal(mini.root.dataset.playingId, 'b')
  } finally {
    env.restore()
  }
})

test('an unplayable answer notifies onUnplayable', async () => {
  const env = install()
  try {
    const { els, mini } = mount()
    let seen = null
    const player = createPlayer({
      els, mini,
      getUrl: async () => ({ url: null, reason: 'rights' }),
      coverFor: () => null,
      onEnded() {},
      onOpen() {},
      onUnplayable(event, result) { seen = { id: event.song_id, reason: result.reason } }
    })
    await player.play({ song_id: 'vip', name: '会员曲' })
    assert.equal(seen?.id, 'vip')
    assert.equal(seen?.reason, 'rights')
    assert.equal(player.current.song_id, 'vip')
    assert.equal(player.playing, false)
  } finally {
    env.restore()
  }
})

test('a cloud APE answer falls back once, then names the format instead of the generic line', async () => {
  const env = install('probably')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push({ ...query })
        return { url: 'https://m801.music.126.net/bad-flac.ape', type: 'ape', br: 850000, duration: 233000, cloud: true, format: 'ape' }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '42', name: 'Fixture One', artists: 'Demo' })
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(queries[0], PLAY_QUERY)
    assert.deepEqual(queries[1], FALLBACK_QUERY)
    assert.equal(queries.length, 2)
    assert.equal(note.textContent, '网盘里这首是 APE 格式，浏览器放不了')
    assert.equal(note.textContent.includes('这边放不了'), false)
    assert.equal(els.play.label, '播放')
    assert.equal(player.playing, false)
  } finally {
    env.restore()
  }
})

test('a cloud upload that later returns standard mp3 plays after the encode fallback', async () => {
  const env = install('')
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push({ ...query })
        if (query.level === 'standard' && query.encodeType === 'mp3') {
          return { url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', br: 128000, duration: 180000 }
        }
        return { url: 'https://m801.music.126.net/bad-flac.ape', type: 'ape', level: 'lossless', br: 850000, duration: 180000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '99', name: 'Fixture Two', artists: 'Demo' })
    await new Promise(r => setTimeout(r, 40))
    assert.deepEqual(queries[0], PLAY_QUERY)
    assert.deepEqual(queries[1], FALLBACK_QUERY)
    assert.equal(env.audio().src, 'https://m801.music.126.net/ok.mp3')
    assert.equal(player.playing, true)
    assert.equal(note.textContent.includes('格式') || note.textContent.includes('没放出来'), false)
  } finally {
    env.restore()
  }
})

test('NotAllowedError does not count as unplayable and does not auto-skip', async () => {
  const env = install()
  try {
    const { els, mini } = mount()
    let seen = 0
    const player = createPlayer({
      els, mini,
      getUrl: async () => ({ url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', duration: 180000 }),
      coverFor: () => null,
      onEnded() {},
      onOpen() {},
      onUnplayable() { seen += 1 }
    })
    env.audio()._fail = 'NotAllowedError'
    const result = await player.play({ song_id: 'ios', name: '手势外' })
    assert.equal(result.ok, false)
    assert.equal(result.blocked, true)
    assert.equal(result.reason, 'blocked')
    assert.equal(result.error, '')
    assert.equal(seen, 0)
    assert.equal(player.playing, false)
    assert.equal(player.current.song_id, 'ios')
    assert.equal(player.note, '')
  } finally {
    env.restore()
  }
})

test('unlock does not replace a real source with a silent clip', async () => {
  const env = install()
  try {
    const { els, mini } = mount()
    const player = createPlayer({
      els, mini,
      getUrl: async () => ({ url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', duration: 180000 }),
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: 'a', name: '甲' })
    const src = env.audio().src
    assert.ok(src.includes('ok.mp3'))
    player.unlock()
    assert.equal(env.audio().src, src)
    assert.equal(src.startsWith('data:'), false)
  } finally {
    env.restore()
  }
})
