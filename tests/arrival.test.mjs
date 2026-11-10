import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
const rule = sel => css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] || ''
const z = body => Number(body.match(/z-index:\s*(-?\d+)/)?.[1])

test('the arrival page paints above every tunnel layer', () => {
  // Tiles (z 1), hero (z 8) and flash (z 7) live in .travel-stage. If the stage is
  // not its own stacking context those z-indexes compete with the arrival page
  // and the tunnel shows through it ("stuck in the tunnel" on iPhone).
  const stage = rule('.travel-stage')
  assert.match(stage, /isolation:\s*isolate/)
  assert.ok(Number.isFinite(z(stage)), 'stage needs an explicit z-index')
  const arrive = rule('.travel-arrive')
  assert.ok(z(arrive) > z(stage), 'arrival must stack above the stage')
  assert.ok(html.indexOf('id="travelArrive"') > html.indexOf('id="travelStage"'))
})

test('every travel phase has a deadline that does not depend on animations or rAF', () => {
  const body = name => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\nfunction ', app.indexOf(`function ${name}(`) + 1))
  const begin = body('beginTravelMotion')
  assert.ok(begin.indexOf("armTravelDeadline('going'") < begin.indexOf('buildTravelTunnel('), 'armed before setup')
  assert.match(body('returnToPresent'), /travel\.phase = 'back'\s*\n(\s*\/\/[^\n]*\n)*\s*armTravelDeadline\('back'/)
  assert.match(body('finishGoing'), /clearTravelDeadline\(\)/)
  assert.match(body('finishTravel'), /clearTravelDeadline\(\)/)
  assert.match(body('finishTravel'), /setTimeout\(revealOnce/)
  for (const name of ['flyTunnel', 'beginTravelMotion', 'finishGoing', 'returnToPresent', 'finishTravel']) {
    assert.doesNotMatch(body(name), /\.finished\.then\(|onfinish|await /, `${name} must not wait on an animation promise to end a trip`)
  }
})

test('the tunnel stage is not painted after arrival', () => {
  // The arrival page stacks above the stage, but a stalled view-transition or a
  // leftover compositor layer can still let the dark tunnel show through the
  // cover. Arrival must hide the stage outright; the rewind un-hides it.
  assert.match(rule('.travel.is-arrive .travel-stage'), /visibility:\s*hidden/)
  const body = name => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\nfunction ', app.indexOf(`function ${name}(`) + 1))
  assert.match(body('showArrival'), /travelStage'\)\.hidden = true/)
  assert.match(body('returnToPresent'), /travelStage'\)\.hidden = false/)
})

test('arrival cover art always fills its square, and a stalled morph is skipped', () => {
  // %-height on an <img> inside an aspect-ratio box is unreliable (especially
  // in WebKit): the image can sit at the top of the card and leave the rest
  // of the card (and the page behind it) black.
  const img = rule('.arrive-art-img, .arrive-art img')
  assert.match(img, /position:\s*absolute/)
  assert.match(img, /inset:\s*0/)
  const finish = app.slice(app.indexOf('function finishGoing('), app.indexOf('\nfunction ', app.indexOf('function finishGoing(') + 1))
  assert.match(finish, /skipTransition/)
  assert.match(finish, /style\.transform = 'none'/)
  // The 1.2s fallback must run even after reveal() has already been called.
  assert.doesNotMatch(finish, /if \(!shown && travel\.phase === 'arrive'\) \{ reveal\(\); unname\(\) \}/)
})
