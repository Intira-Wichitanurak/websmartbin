/**
 * WebSocket hub client — เชื่อมเข้า WebSocket hub บน Pi (scripts/ws-hub.js)
 * ที่รวมทุกอุปกรณ์ ESP32 ไว้ที่เดียว
 *
 * รับ (จาก ESP32 ผ่าน hub):
 *   node="sensor" → event "detected" / "cleared" / "weight"  (+ grams)
 *   node="bins"   → event "levels"  (+ bins: [{i,cm,pct,color}, ...])
 *
 * ส่ง (ไป ESP32 ผ่าน hub) — ใช้ผ่าน getSensor().send(obj) เช่นใน src/lib/relay.js:
 *   {node:"relay", event:"classify", type:"wet"}      → ESP32 #2 (relay)
 *   {node:"leds",  event:"set", leds:[...]}            → ESP32 #3 (RGB LED)
 *
 * ตั้ง URL ผ่าน env:  VITE_SENSOR_WS_URL=ws://192.168.50.1:8181/
 * (Pi เป็น WiFi AP ที่ IP 192.168.50.1 — ดู scripts/setup-ap.sh)
 * ค่าเริ่มต้น ws://localhost:8181/ สำหรับ dev บนเครื่องเดียว
 *
 * auto-reconnect ทุก 10s ถ้าหลุด
 */

const DEFAULT_URL  = 'ws://localhost:8181/'   // ตรงกับ scripts/ws-hub.js
const RECONNECT_MS = 10000

let singleton = null

export function getSensor() {
  if (!singleton) {
    if (import.meta.env?.VITE_SENSOR_ENABLED === 'false') {
      singleton = createStub()
    } else {
      const url = import.meta.env?.VITE_SENSOR_WS_URL || DEFAULT_URL
      singleton = createSensor(url)
    }
  }
  return singleton
}

/** Inert client — ทำอะไรไม่ได้ แต่มี API เหมือนกัน (ตอน dev ไม่มี ESP32) */
function createStub() {
  const listeners = new Set()
  let lastEvent = null
  let lastWeight = null
  let lastBins = null
  console.info('[sensor] disabled (set VITE_SENSOR_ENABLED=true and VITE_SENSOR_WS_URL to enable)')
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    isConnected() { return false },
    send() { /* no-op */ },
    dispatch(event, data) {
      lastEvent = event
      if (data?.grams != null) lastWeight = data.grams
      if (event === 'levels' && data?.bins) lastBins = data.bins
      listeners.forEach(fn => fn(event, data))
    },
    lastEvent:  () => lastEvent,
    lastWeight: () => lastWeight,
    lastBins:   () => lastBins,
  }
}

function createSensor(url) {
  const listeners = new Set()
  let ws = null
  let reconnectTimer = null
  let connected = false
  let lastEvent = null
  let lastWeight = null
  let lastBins = null

  function emit(event, data) {
    lastEvent = event
    if (data && typeof data === 'object' && typeof data.grams === 'number') {
      lastWeight = data.grams
    }
    if (event === 'levels' && Array.isArray(data?.bins)) lastBins = data.bins
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

      // plain string (เช่น dev dispatch) → ใช้เป็นชื่อ event ตรงๆ
      if (typeof payload === 'string') {
        const event = payload.trim().toLowerCase()
        if (event) emit(event, null)
        return
      }

      // เราสนใจเฉพาะ node ที่รับเข้า: sensor + bins (relay/leds เป็นคำสั่งขาออก)
      const node = (payload.node || '').toLowerCase()
      if (node && node !== 'sensor' && node !== 'bins') return

      const event = (payload.event || '').toLowerCase()
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
    /** ส่ง object ไป hub (ESP32 ปลายทางกรองด้วยฟิลด์ node) — no-fail ถ้ายังไม่ต่อ */
    send(obj) {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
      } catch (e) { /* socket ยังไม่พร้อม — เงียบไว้ */ }
    },
    /** dispatch event ในเครื่อง (ใช้กับปุ่มลัด dev) */
    dispatch(event, data) { emit(event.toLowerCase(), data) },
    lastEvent:    () => lastEvent,
    lastWeight:   () => lastWeight,
    /** ระดับขยะล่าสุดของถังทุกใบ (array) หรือ null ถ้ายังไม่เคยได้รับ */
    lastBins:     () => lastBins,
  }
}
