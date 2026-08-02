/**
 * Bin-fill status client — connects over WiFi to the *second* ESP32.
 *
 * The first ESP32 (esp32_sensor_sharp_ir) watches the drop point via UART and
 * emits detected/cleared/weight (see src/lib/sensor.js). This second ESP32 sits
 * on the bins themselves — one distance sensor per bin — and reports when a bin
 * is FULL and can no longer accept waste. It joins the same WiFi and hosts its
 * own WebSocket server, so the browser connects to it directly.
 *
 * Point the app at it via Vite env:
 *     VITE_BIN_WS_URL=ws://192.168.1.60:81/
 * (set in .env / .env.local). Defaults to ws://bin-esp32.local:81/.
 * Disable entirely (dev without the board) with VITE_BIN_ENABLED=false.
 *
 * Message formats accepted (any of these — the ESP32 may send whichever is
 * easiest to produce):
 *   "full:recyclable"                                 (plain string, becomes full)
 *   "ok:recyclable"                                   (plain string, no longer full)
 *   {"event":"full","bin":"recyclable"}               (one bin became full)
 *   {"event":"ok","bin":"recyclable"}                 (bin has room again)
 *   {"event":"bin_status","full":["recyclable"]}      (snapshot — list of full bins)
 *   {"event":"bin_status","bins":{"wet":false,...}}   (snapshot — per-bin bool)
 *
 * Bin keys match WASTE_TYPES / relay names: wet | recyclable | hazardous | general
 *
 * Auto-reconnects every 10s if the socket drops.
 */

export const BIN_KEYS = ['wet', 'recyclable', 'hazardous', 'general']

const DEFAULT_URL  = 'ws://bin-esp32.local:81/'
const RECONNECT_MS = 10000

let singleton = null

export function getBinStatus() {
  if (!singleton) {
    if (import.meta.env?.VITE_BIN_ENABLED === 'false') {
      singleton = createClient(null)          // inert, but dev shortcuts still work
    } else {
      const url = import.meta.env?.VITE_BIN_WS_URL || DEFAULT_URL
      singleton = createClient(url)
    }
  }
  return singleton
}

function emptyState() {
  return BIN_KEYS.reduce((o, k) => (o[k] = false, o), {})
}

function createClient(url) {
  const listeners = new Set()
  const full      = emptyState()   // { wet:false, recyclable:false, ... }
  let ws          = null
  let reconnect   = null
  let connected   = false

  /** Notify subscribers. `info` describes what changed (or open/close). */
  function emit(info) {
    listeners.forEach(fn => { try { fn({ ...full }, info) } catch (e) { console.error(e) } })
  }

  /** Set one bin's fullness; emit an 'update' only when it actually changes. */
  function apply(bin, isFull) {
    if (!BIN_KEYS.includes(bin)) return
    if (full[bin] === isFull) return
    full[bin] = isFull
    emit({ type: 'update', bin, isFull })
  }

  /** Replace the whole snapshot (from a bin_status message on connect). */
  function applySnapshot(next) {
    for (const bin of BIN_KEYS) apply(bin, !!next[bin])
  }

  function handleMessage(raw) {
    let payload = raw
    try { payload = JSON.parse(raw) } catch { /* plain string */ }

    // plain string form: "full:recyclable" / "ok:recyclable"
    if (typeof payload === 'string') {
      const [ev, bin] = payload.trim().toLowerCase().split(':')
      if (bin) apply(bin, ev === 'full')
      return
    }
    if (!payload || typeof payload !== 'object') return

    const event = String(payload.event || '').toLowerCase()

    if (event === 'bin_status') {
      if (Array.isArray(payload.full)) {
        applySnapshot(BIN_KEYS.reduce((o, k) => (o[k] = payload.full.includes(k), o), {}))
      } else if (payload.bins && typeof payload.bins === 'object') {
        applySnapshot(payload.bins)
      }
      return
    }
    if (event === 'full' || event === 'ok' || event === 'empty' || event === 'not_full') {
      const bin = String(payload.bin || '').toLowerCase()
      apply(bin, event === 'full')
    }
  }

  function connect() {
    if (!url) return                       // disabled — inert client
    try { ws = new WebSocket(url) }
    catch { scheduleReconnect(); return }

    ws.onopen = () => {
      connected = true
      console.log('[bin] connected:', url)
      emit({ type: 'open' })
    }
    ws.onmessage = (msg) => handleMessage(msg.data)
    ws.onclose = () => {
      if (connected) console.log('[bin] disconnected')
      connected = false
      emit({ type: 'close' })
      scheduleReconnect()
    }
    ws.onerror = () => { /* close fires next */ }
  }

  function scheduleReconnect() {
    if (reconnect || !url) return
    reconnect = setTimeout(() => { reconnect = null; connect() }, RECONNECT_MS)
  }

  connect()

  return {
    on(fn)        { listeners.add(fn); return () => listeners.delete(fn) },
    isConnected() { return connected },
    isFull(bin)   { return !!full[bin] },
    snapshot()    { return { ...full } },
    fullBins()    { return BIN_KEYS.filter(k => full[k]) },
    /** Manually flip a bin (used by dev keyboard shortcuts to test without the board). */
    setFull(bin, isFull) { apply(bin, isFull) },
  }
}
