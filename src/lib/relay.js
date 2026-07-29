/**
 * Relay control — แยก  2 เส้นทางตามสถาปัตยกรรม:
 *
 *   ไฟบอกประเภทขยะ 4 ดวง (wet/recyclable/hazardous/general)
 *     → ส่งผ่าน WebSocket hub ไป ESP32 NODE #2  (getSensor().send)
 *
 *   ไฟกล้อง 1 ดวง
 *     → ยิง HTTP POST ไป model_server.py (/camera) ที่คุม Pi GPIO เอง
 *
 * ทุกคำสั่งเป็น no-fail (เงียบถ้า socket/server ยังไม่พร้อม)
 */

import { getSensor } from './sensor.js'

const MODEL_API_URL = import.meta.env?.VITE_MODEL_API_URL || 'http://localhost:8000/classify'
const CAMERA_API_URL =
  import.meta.env?.VITE_CAMERA_API_URL ||
  MODEL_API_URL.replace(/\/classify\/?$/, '/camera')

/** ไฟประเภทขยะ → WebSocket ไป ESP32 #2 */
function sendRelay(payload) {
  getSensor().send({ node: 'relay', ...payload })
}

/** ไฟกล้อง → HTTP ไป Pi (model_server.py) */
function postCamera(on) {
  return fetch(CAMERA_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ on }),
  }).catch(err => {
    if (!postCamera._warned) {
      console.warn('[relay] camera server unreachable at', CAMERA_API_URL, '—', err?.message || err)
      postCamera._warned = true
    }
  })
}

/** เปิดรีเลย์ประเภทขยะที่ตรงกับผลจำแนก ปิดตัวอื่น (ESP32 ดับเองใน 20s) */
export function relayForType(type) {
  sendRelay({ event: 'classify', type })
}

/** เปิดไฟกล้อง (Pi GPIO) */
export function relayCameraActive() {
  postCamera(true)
}

/** ปิดไฟกล้อง (Pi GPIO) */
export function relayCameraOff() {
  postCamera(false)
}

/** ปิดไฟประเภทขยะทุกดวง (ESP32 #2) + ปิดไฟกล้อง (Pi) */
export function relayAllOff() {
  sendRelay({ event: 'all_off' })
  postCamera(false)
}
