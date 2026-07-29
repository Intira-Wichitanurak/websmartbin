/**
 * WebSocket hub — ศูนย์กลางสื่อสารของระบบ (แทน serial-bridge.js เดิม)
 *
 * ทุกอุปกรณ์เชื่อมเข้ามาที่ ws://<pi>:8181/ :
 *   - ESP32 #1 (sensor) : ส่ง {"node":"sensor","event":"detected|cleared|weight","grams":..}
 *   - ESP32 #2 (relay)  : รับ  {"node":"relay","event":"classify|camera_active|camera_off|all_off",..}
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

const WS_PORT = Number(process.env.HUB_WS_PORT || 8181)

const wss = new WebSocketServer({ port: WS_PORT })
console.log(`[hub] WebSocket listening on ws://0.0.0.0:${WS_PORT}/`)

// เก็บ message ล่าสุดต่อ node เพื่อ replay ให้ client ที่เพิ่งต่อ (เช่น เว็บ reload
// แล้วอยากเห็นระดับถัง/น้ำหนักล่าสุดทันที)
const lastByNode = new Map()

function nodeOf(line) {
  try { return JSON.parse(line)?.node || null } catch { return null }
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

    const node = nodeOf(line)
    if (node) lastByNode.set(node, line)
    console.log('[hub] <-', line)

    // broadcast ให้ทุกคน ยกเว้นผู้ส่ง
    for (const peer of wss.clients) {
      if (peer !== client && peer.readyState === 1) peer.send(line)
    }
  })

  client.on('close', () => console.log(`[hub] client disconnected: ${who}`))
  client.on('error', (e) => console.warn('[hub] client error:', e.message))
})
