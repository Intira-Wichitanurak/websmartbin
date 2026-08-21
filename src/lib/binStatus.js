/**
 * สถานะ "ถังเต็ม" ของทั้ง 4 ถัง — เก็บไว้ในหน่วยความจำเฉย ๆ ไม่ต่อเน็ตเวิร์กเอง
 *
 * ระดับขยะจริงมาจาก ESP32 #3 ผ่าน WebSocket hub แล้ว App.jsx เป็นตัวแปลง
 * event 'levels' → setFull() ให้ (ดู BIN_INDEX_TO_TYPE + BIN_FULL_PCT ใน App.jsx)
 * ปุ่มลัด dev 1-4 ก็เรียก setFull() เส้นทางเดียวกัน ส่วน ResultPage อ่านด้วย isFull()
 * ทุกครั้งที่ใช้ เพราะค่าพลิกได้ระหว่างที่หน้าผลลัพธ์กำลังเล่นอยู่
 *
 * เดิมไฟล์นี้เปิด WebSocket ไปหา ESP32 วัดระดับถังตัวเก่า (bin-esp32.local:81)
 * ซึ่งเลิกใช้ตั้งแต่ย้ายทุก node มารวมที่ hub — โค้ดส่วนนั้นถูกถอดออกแล้ว
 */

export const BIN_KEYS = ['wet', 'recyclable', 'hazardous', 'general']

let singleton = null

export function getBinStatus() {
  if (!singleton) singleton = createStore()
  return singleton
}

function createStore() {
  const full = BIN_KEYS.reduce((o, k) => (o[k] = false, o), {})

  return {
    isFull(bin) { return !!full[bin] },
    setFull(bin, isFull) {
      if (BIN_KEYS.includes(bin)) full[bin] = !!isFull
    },
  }
}
