/**
 * WebSocket hub — ศูนย์กลางสื่อสารของระบบ (แทน serial-bridge.js เดิม)
 *
 * ทุกอุปกรณ์เชื่อมเข้ามาที่ ws://<pi>:8181/ :
 *   - ESP32 #1 (sensor) : ส่ง {"node":"sensor","event":"detected|cleared|weight","grams":..}
 *                         + {"node":"camera","event":"on"} → hub ยิงไฟกล้องให้ทันที
 *                           (ดู cameraLight ด้านล่าง — ไม่ผ่านเบราว์เซอร์)
 *   - ESP32 #2 (relay)  : รับ  {"node":"relay","event":"classify|all_off",..}
 *                         (ไฟกล้องไม่เกี่ยวกับ node นี้ — Pi คุมขา GPIO เอง)
 *   - ESP32 #3 (bins)   : ส่ง {"node":"bins","event":"levels","bins":[..]}  / รับ {"node":"leds",..}
 *   - เว็บ React        : รับ sensor+bins, ส่ง relay+leds
 *
 * hub เป็น "dumb broadcast": ทุก message ที่เข้ามา จะส่งต่อให้ client ตัวอื่นทุกตัว
 * (ยกเว้นตัวที่ส่งมาเอง) แล้วให้แต่ละฝั่งกรองเองด้วยฟิลด์ `node`
 *
 * ข้อดี: Pi เป็น endpoint เดียวที่ทุกคนรู้จัก — ไม่ต้องรู้ IP ของ ESP32 แต่ละตัว
 *
 * รัน: node scripts/ws-hub.js   (หรือ npm run dev:hub)
 */

import { WebSocketServer } from 'ws'

const WS_PORT    = Number(process.env.HUB_WS_PORT || 8181)
const CAMERA_URL = process.env.CAMERA_API_URL || 'http://127.0.0.1:8000/camera'

const wss = new WebSocketServer({ port: WS_PORT })
console.log(`[hub] WebSocket listening on ws://0.0.0.0:${WS_PORT}/`)

// เก็บ message ล่าสุดต่อ node เพื่อ replay ให้ client ที่เพิ่งต่อ (เช่น เว็บ reload
// แล้วอยากเห็นระดับถัง/น้ำหนักล่าสุดทันที)
const lastByNode = new Map()

function parse(line) {
  try { return JSON.parse(line) } catch { return null }
}

/** ไฟกล้อง (Pi GPIO ผ่าน model_server.py) — no-fail, เตือนครั้งเดียวถ้าต่อไม่ได้ */
function cameraLight(on) {
  fetch(CAMERA_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ on }),
  }).catch(err => {
    if (!cameraLight._warned) {
      console.warn('[hub] camera server unreachable at', CAMERA_URL, '—', err.message)
      cameraLight._warned = true
    }
  })
}

wss.on('connection', (client, req) => {
  const who = req.socket.remoteAddress
  console.log(`[hub] client connected: ${who}`)

  // replay สถานะล่าสุดของทุก node ให้ client ใหม่
  for (const line of lastByNode.values()) {
    if (client.readyState === 1) client.send(line)
  }

  client.on('message', (data) => {
    const line = data.toString().trim()
    if (!line) return

    const msg  = parse(line)
    const node = msg?.node || null
    if (node) lastByNode.set(node, line)
    console.log('[hub] <-', line)

    // ไฟกล้อง — ESP32 #1 ยิง {"node":"camera","event":"on"} เองเมื่อเห็นของ
    // hub อยู่บน Pi เครื่องเดียวกับ model_server อยู่แล้ว จึงยิง GPIO ต่อได้เลย
    // ไม่ต้องอ้อมผ่านเบราว์เซอร์
    //
    // event:"off" ก็ส่งต่อเหมือนกัน — node #1 จะสั่งดับเฉพาะตอนที่ยังถือสิทธิ์อยู่
    // (สถานะ LIGHT_ARMED = จุดไฟแล้วแต่ยังไม่เกิด detected) พอเกิดแล้วมันจะ
    // ส่งมอบให้เว็บและไม่แตะไฟอีกจนกว่าจะได้ all_off คืน — ดู lightOwner ใน
    // esp32_node1_sensor.ino. ยังมี CAMERA_AUTO_OFF_S ฝั่ง model_server เป็นตาข่ายรอง
    if (node === 'camera') cameraLight(msg.event !== 'off')

    // broadcast ให้ทุกคน ยกเว้นผู้ส่ง
    for (const peer of wss.clients) {
      if (peer !== client && peer.readyState === 1) peer.send(line)
    }
  })

  client.on('close', () => console.log(`[hub] client disconnected: ${who}`))
  client.on('error', (e) => console.warn('[hub] client error:', e.message))
})
