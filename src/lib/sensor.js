/**
 * WebSocket sensor client — connects to an ESP32 (or any device) that
 * broadcasts events: "detected" when waste is placed, "cleared" when removed.
 *
 * The ESP32 should host a WebSocket server (port 81 is conventional with the
 * `WebSocketsServer` Arduino library) and broadcast text messages such as
 * "detected" / "cleared", or JSON like {"event":"detected"}.
 *
 * Configure the WebSocket URL via Vite env var:
 *     VITE_SENSOR_WS_URL=ws://192.168.1.42:81/
 * (set in .env / .env.local). Defaults to ws://localhost:81/ for local dev.
 *
 * The client auto-reconnects every 3s if the socket drops.
 */

const DEFAULT_URL    = 'ws://localhost:8181/'   // ตรงกับ scripts/serial-bridge.js
const RECONNECT_MS   = 10000   // 10s between reconnect attempts (was 3s — too spammy)

let singleton = null

export function getSensor() {
  if (!singleton) {
    // Skip WebSocket entirely if explicitly disabled — useful when developing
    // without an ESP32 around (avoids the recurring "WebSocket failed" log).
    if (import.meta.env?.VITE_SENSOR_ENABLED === 'false') {
      singleton = createStub()
    } else {
      const url = import.meta.env?.VITE_SENSOR_WS_URL || DEFAULT_URL
      singleton = createSensor(url)
    }
  }
  return singleton
}

/** Inert sensor — does nothing, but exposes the same API. */
function createStub() {
  const listeners = new Set()
  let lastEvent = null
  let lastWeight = null
  console.info('[sensor] disabled (set VITE_SENSOR_ENABLED=true and VITE_SENSOR_WS_URL to enable)')
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    isConnected() { return false },
    dispatch(event, data) {
      lastEvent = event
      if (data && typeof data === 'object' && typeof data.grams === 'number') {
        lastWeight = data.grams
      }
      listeners.forEach(fn => fn(event, data))
    },
    lastEvent:  () => lastEvent,
    lastWeight: () => lastWeight
  }
}

function createSensor(url) {
  const listeners = new Set()
  let ws = null
  let reconnectTimer = null
  let connected = false
  let lastEvent = null
  let lastWeight = null   // grams — populated from any event payload that carries `grams`

  function emit(event, data) {
    lastEvent = event
    if (data && typeof data === 'object' && typeof data.grams === 'number') {
      lastWeight = data.grams
    }
    listeners.forEach(fn => { try { fn(event, data) } catch (e) { console.error(e) } })
  }

  function connect() {
    try {
      ws = new WebSocket(url)
    } catch (e) {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connected = true
      console.log('[sensor] connected:', url)
      emit('open')
    }

    ws.onmessage = (msg) => {
      let payload = msg.data
      try { payload = JSON.parse(payload) } catch { /* plain string */ }
      const event = typeof payload === 'string' ? payload.trim().toLowerCase() : (payload?.event || '').toLowerCase()
      if (!event) return
      emit(event, payload)
    }

    ws.onclose = () => {
      if (connected) console.log('[sensor] disconnected')
      connected = false
      emit('close')
      scheduleReconnect()
    }

    ws.onerror = () => { /* close handler will fire next */ }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, RECONNECT_MS)
  }

  connect()

  return {
    on(fn)        { listeners.add(fn); return () => listeners.delete(fn) },
    isConnected() { return connected },
    /** Manually dispatch an event (used for dev keyboard shortcuts) */
    dispatch(event, data) { emit(event.toLowerCase(), data) },
    /** What the last event we saw was — handy for late subscribers */
    lastEvent:    () => lastEvent,
    /** Latest weight reading (grams) from the load cell, or null if never seen */
    lastWeight:   () => lastWeight
  }
}
