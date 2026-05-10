/**
 * Serial → WebSocket bridge.
 *
 * ESP32 ส่ง JSON event บรรทัดละ message ผ่าน UART2 → Pi /dev/serial0 (ttyAMA0).
 * สคริปต์นี้:
 *   1) เปิด serial port ที่ 115200 baud
 *   2) เปิด WebSocket server ที่ port 81 (ตรงกับที่ src/lib/sensor.js เคยเชื่อมไป ESP32)
 *   3) ทุกบรรทัดที่อ่านได้ broadcast ไปยัง client ทุกตัว
 *
 * ทำให้ฝั่ง React ไม่ต้องแก้อะไรเลย — ยังเชื่อม ws://localhost:81/ เหมือนเดิม
 *
 * รัน: node scripts/serial-bridge.js
 *      หรือ npm run dev:bridge
 */

import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { WebSocketServer } from 'ws'

const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/serial0'
const BAUD_RATE   = Number(process.env.SERIAL_BAUD || 115200)
const WS_PORT     = Number(process.env.BRIDGE_WS_PORT || 8181)

const wss = new WebSocketServer({ port: WS_PORT })
console.log(`[bridge] WebSocket listening on ws://localhost:${WS_PORT}/`)

let lastMessage = null   // ส่งสถานะล่าสุดให้ client ที่เพิ่งต่อ

wss.on('connection', (client) => {
  console.log('[bridge] web client connected')
  if (lastMessage) client.send(lastMessage)
  client.on('close', () => console.log('[bridge] web client disconnected'))
})

function broadcast(line) {
  lastMessage = line
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(line)
  }
}

function openSerial() {
  const port = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD_RATE })
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))

  port.on('open',  () => console.log(`[bridge] serial open: ${SERIAL_PATH} @ ${BAUD_RATE}`))
  port.on('error', (e) => {
    console.error('[bridge] serial error:', e.message)
    setTimeout(openSerial, 3000)
  })
  port.on('close', () => {
    console.warn('[bridge] serial closed — retrying in 3s')
    setTimeout(openSerial, 3000)
  })

  parser.on('data', (raw) => {
    const line = raw.trim()
    if (!line) return
    console.log('[bridge] <-', line)
    broadcast(line)
  })
}

openSerial()
