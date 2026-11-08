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
      this.error = { code: 4 }
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
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = '' }
}

function mount() {
  const note = { textContent: '', hidden: true }
  const root = { classList: { toggle() {} } }
  const dialog = { open: false, classList: { toggle() {} } }
  const play = { disabled: false, setAttribute() {}, addEventListener() {} }
  const seek = { value: '0', disabled: false, addEventListener() {} }
  const scrub = { style: { setProperty() {} } }
  const cur = { textContent: '0:00' }, dur = { textContent: '0:00' }
  const volume = { value: 1, style: { setProperty() {} }, addEventListener() {} }
  const mini = {
    root: { hidden: true, classList: { toggle() {} }, style: { setProperty() {} } },
    play: { setAttribute() {}, addEventListener() {} },
    open: { addEventListener() {} },
    close: { addEventListener() {} },
    title: { textContent: '' }, artist: { textContent: '' },
    cover: { replaceChildren() {}, append() {} }
  }
  return { els: { root, dialog, play, seek, scrub, cur, dur, note, volume }, mini, note }
}

test('playErrorMessage distinguishes unsupported formats from a cancelled play()', () => {
  assert.equal(playErrorMessage({ name: 'NotAllowedError' }), '')
  assert.equal(playErrorMessage({ name: 'AbortError' }), null)
  assert.equal(playErrorMessage({ name: 'NotSupportedError' }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }, { code: 4 }), PLAYER_LINES.unsupported)
  assert.equal(playErrorMessage({ name: 'Error' }), PLAYER_LINES.failed)
  assert.deepEqual(FALLBACK_QUERY, { level: 'standard', encodeType: 'mp3' })
})

test('a URL the browser cannot decode falls back to standard mp3', async () => {
  const Original = globalThis.Audio
  globalThis.Audio = FakeAudio
  globalThis.document = { body: { classList: { toggle() {} } }, createElement: () => ({ canPlayType: () => '' }) }
  try {
    const { els, mini, note } = mount()
    const queries = []
    const player = createPlayer({
      els, mini,
      getUrl: async (_event, query = {}) => {
        queries.push(query)
        if (query.level === 'standard') return { url: 'https://m801.music.126.net/ok.mp3', type: 'mp3', duration: 180000 }
        return { url: 'https://m801.music.126.net/bad-flac.flac', type: 'flac', duration: 180000 }
      },
      coverFor: () => null,
      onEnded() {},
      onOpen() {}
    })
    await player.play({ song_id: '28151022', name: '鳥の詩', artists: 'Lia' })
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(queries[0], {})
    assert.ok(queries.some(q => q.level === 'standard' && q.encodeType === 'mp3'))
    assert.equal(note.textContent.includes('没放出来') || note.textContent.includes('格式'), false)
  } finally {
    globalThis.Audio = Original
  }
})

test('a first getUrl failure retries at standard mp3 before showing an error', async () => {
  const Original = globalThis.Audio
  globalThis.Audio = FakeAudio
  globalThis.document = { body: { classList: { toggle() {} } }, createElement: () => ({ canPlayType: () => 'probably' }) }
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
    globalThis.Audio = Original
  }
})
