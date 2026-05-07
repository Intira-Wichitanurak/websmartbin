// Cute capybara-ish sound effects synthesized with the Web Audio API.
// No external audio files. Browsers require a user gesture before audio can
// start, so call `unlockAudio()` from any click handler at app start.

let ctx = null
let master = null
let muted = false

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx    = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 0.9
    // soften everything with a gentle low-pass for a "cute" tone
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3200
    lp.Q.value = 0.6
    master.connect(lp).connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

export function unlockAudio() { getCtx() }

export function setMuted(v) {
  muted = !!v
  if (master) master.gain.value = muted ? 0 : 0.9
  try { localStorage.setItem('capy.muted', muted ? '1' : '0') } catch {}
}
export function isMuted() {
  try { return localStorage.getItem('capy.muted') === '1' } catch { return muted }
}
muted = isMuted()

// --- primitives -------------------------------------------------------------

function chirp({ from, to, dur = 0.18, peak = 0.22, type = 'triangle', delay = 0 }) {
  const c = getCtx(); if (!c) return
  const t = c.currentTime + delay
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(from, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master)
  o.start(t)
  o.stop(t + dur + 0.05)
}

function noise({ dur = 0.1, peak = 0.18, freq = 1500, q = 1, delay = 0 }) {
  const c = getCtx(); if (!c) return
  const t = c.currentTime + delay
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1)
  const src = c.createBufferSource(); src.buffer = buf
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(bp).connect(g).connect(master)
  src.start(t)
  src.stop(t + dur + 0.02)
}

// --- named effects ----------------------------------------------------------

export const sfx = {
  // n. greet — soft "wheek wheek" rising chirp pair
  greet() {
    chirp({ from: 520, to: 880, dur: 0.18, peak: 0.22 })
    chirp({ from: 700, to: 1050, dur: 0.16, peak: 0.20, delay: 0.18 })
  },
  // light tap
  click() {
    chirp({ from: 1200, to: 700, dur: 0.07, peak: 0.14, type: 'sine' })
  },
  // page transition — a short happy "bup"
  page() {
    chirp({ from: 600, to: 900, dur: 0.12, peak: 0.18 })
  },
  // camera shutter — short filtered noise burst
  shutter() {
    noise({ dur: 0.08, peak: 0.32, freq: 2400, q: 0.8 })
    chirp({ from: 1800, to: 1200, dur: 0.05, peak: 0.10, type: 'sine', delay: 0.05 })
  },
  // processing — soft thinking "hmm"
  thinking() {
    chirp({ from: 380, to: 460, dur: 0.22, peak: 0.16, type: 'sine' })
    chirp({ from: 460, to: 380, dur: 0.22, peak: 0.14, type: 'sine', delay: 0.22 })
  },
  // success — happy 3-note rise
  success() {
    chirp({ from: 660, to: 700, dur: 0.10, peak: 0.20 })
    chirp({ from: 880, to: 920, dur: 0.10, peak: 0.20, delay: 0.10 })
    chirp({ from: 1175, to: 1320, dur: 0.20, peak: 0.22, delay: 0.20 })
  },
  // alert — soft two-tone "uh-oh"
  alert() {
    chirp({ from: 700, to: 700, dur: 0.14, peak: 0.22, type: 'sine' })
    chirp({ from: 520, to: 520, dur: 0.20, peak: 0.22, type: 'sine', delay: 0.16 })
  },
  // thank you — cheerful 4-note melody
  thankyou() {
    chirp({ from: 660, to: 660, dur: 0.12, peak: 0.20 })
    chirp({ from: 880, to: 880, dur: 0.12, peak: 0.20, delay: 0.12 })
    chirp({ from: 990, to: 990, dur: 0.12, peak: 0.20, delay: 0.24 })
    chirp({ from: 1320, to: 1320, dur: 0.30, peak: 0.24, delay: 0.36 })
  }
}

/* --------------------------------------------------------------------------
 *  speak() — REAL Thai speech using browser TTS (window.speechSynthesis)
 *  • Picks a Thai voice if one is installed (Premwadee on Windows, Kanya on
 *    macOS, etc).
 *  • Tweak pitch/rate to make it sound young & cute (capybara-friendly).
 *  • Respects the global mute toggle.
 *  • Cancels any in-flight speech before starting a new one.
 *  • If no Thai voice is available, falls back to silent (no garbled English).
 * -------------------------------------------------------------------------- */

const SS = typeof window !== 'undefined' ? window.speechSynthesis : null

let thaiVoice = null

/**
 * Pick the most cartoon-friendly Thai voice available.
 * - Prefer female voices (typically lighter/younger sound)
 * - Skip explicit "male" voices
 * - As a last resort, any Thai voice will do
 */
function pickThaiVoice() {
  if (!SS) return null
  const voices = SS.getVoices().filter(v => v.lang?.startsWith('th'))
  if (!voices.length) return null

  // Prefer known cute/female-sounding voices
  const preferred = [/premwadee/i, /kanya/i, /narisa/i, /noppakao/i, /female/i]
  for (const re of preferred) {
    const v = voices.find(x => re.test(x.name))
    if (v) return v
  }
  // Otherwise drop anything obviously male
  const nonMale = voices.find(v => !/male|niwat|chinmaya/i.test(v.name))
  return nonMale || voices[0]
}

if (SS) {
  thaiVoice = pickThaiVoice()
  SS.addEventListener?.('voiceschanged', () => { thaiVoice = pickThaiVoice() })
}

export function stopSpeech() { if (SS) SS.cancel() }

/**
 * Cartoon-character speech.
 * Pumps pitch to the browser maximum (2.0) and tops it with a tiny "ah!"
 * chirp before each utterance so it sounds like a personality, not a
 * monotone AI reading.
 */
export function speak(text, opts = {}) {
  if (!text || !SS || muted) return Promise.resolve()

  const clean = String(text)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return Promise.resolve()

  SS.cancel()

  const {
    pitch        = 2.0,    // browser max — chipmunky cartoon timbre
    rate         = 1.18,   // a touch faster = more energetic, less robotic
    volume       = 1,
    lang         = 'th-TH',
    chirpBefore  = true,   // little vocal "ah!" / "ehe!" before talking
    chirpAfter   = false   // optional rising chirp after talking
  } = opts

  const u = new SpeechSynthesisUtterance(clean)
  u.lang   = lang
  u.pitch  = Math.max(0, Math.min(2, pitch))
  u.rate   = Math.max(0.1, Math.min(10, rate))
  u.volume = Math.max(0, Math.min(1, volume))
  if (thaiVoice) u.voice = thaiVoice

  return new Promise(resolve => {
    if (chirpBefore) {
      // Two quick rising chirps = a cute "eh-eh!" attention-getter.
      // These layer on top so the sentence feels like a character expressing itself.
      chirp({ from: 900,  to: 1300, dur: 0.06, peak: 0.16, type: 'triangle' })
      chirp({ from: 1100, to: 1500, dur: 0.07, peak: 0.14, type: 'sine', delay: 0.07 })
    }

    u.onend   = () => {
      if (chirpAfter) chirp({ from: 900, to: 1400, dur: 0.08, peak: 0.16, type: 'triangle' })
      resolve()
    }
    u.onerror = () => resolve()

    // Tiny delay so the intro chirp plays before the speech starts
    setTimeout(() => SS.speak(u), chirpBefore ? 140 : 0)
  })
}

/** Diagnostics: list installed voices in the console (call from devtools) */
export function listVoices() {
  if (!SS) return []
  const v = SS.getVoices()
  console.table(v.map(x => ({ name: x.name, lang: x.lang, default: x.default })))
  return v
}

/* --------------------------------------------------------------------------
 *  playVoice(clipName, fallbackText)
 *
 *  Tries to play a pre-recorded mp3 from /public/voice/<clipName>.mp3.
 *  If the file isn't there (404 / load error), falls back to TTS speak().
 *
 *  Why: real character voice acting always beats browser TTS for kid apps.
 *  Generate the clips yourself (record on phone) or with a service like
 *  ElevenLabs / VoiceMaker / Murf.ai with a cute character voice, then drop
 *  them into public/voice/ — no code changes needed.
 *
 *  Required clips (the app will gracefully fall back to TTS for any missing):
 *    welcome.mp3
 *    watching.mp3   scanning.mp3   processing.mp3
 *    denied.mp3     unsupported.mp3
 *    result_general.mp3   result_recyclable.mp3
 *    result_hazardous.mp3 result_wet.mp3
 *    popup_blurry.mp3     popup_food.mp3
 *    thankyou.mp3
 * -------------------------------------------------------------------------- */

const clipCache = new Map()  // clipName → Audio element (preloaded)

export function preloadVoice(clipName) {
  if (clipCache.has(clipName)) return
  const a = new Audio(`/voice/${clipName}.mp3`)
  a.preload = 'auto'
  clipCache.set(clipName, a)
}

let currentClip = null

export function playVoice(clipName, fallbackText, opts = {}) {
  if (muted) return Promise.resolve()

  // stop any previous clip / TTS
  if (currentClip) { try { currentClip.pause(); currentClip.currentTime = 0 } catch {} }
  if (SS) SS.cancel()

  return new Promise(resolve => {
    const audio = new Audio(`/voice/${clipName}.mp3`)
    audio.volume = 1
    currentClip = audio

    const fallback = () => {
      currentClip = null
      if (fallbackText) speak(fallbackText, opts).then(resolve)
      else resolve()
    }

    audio.onended = () => { currentClip = null; resolve() }
    audio.onerror = fallback

    audio.play().catch(fallback)   // covers 404 / autoplay-blocked
  })
}
