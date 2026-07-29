# 🐹 Capybara Waste Sorter

แอปแยกขยะน่ารัก ๆ พร้อมมาสคอตคาปิบารา สร้างด้วย **React + Vite + TailwindCSS**

## 🚀 เริ่มต้นใช้งาน

```bash
npm install
npm run dev
```

แล้วเปิด http://localhost:5173

> หน้าถ่ายภาพต้องการสิทธิ์เข้าถึงกล้อง — เบราว์เซอร์ส่วนใหญ่ต้องเปิดผ่าน `localhost` หรือ `https`

## 🧭 โครงสร้างหน้า

| # | หน้า | ไฟล์ |
|---|------|------|
| 1 | **พร้อมใช้งาน** — ทักทายและปุ่มเริ่ม | `src/pages/ReadyPage.jsx` |
| 2 | **ถ่ายภาพ + ประมวลผลโมเดล** | `src/pages/CameraPage.jsx` |
| 3 | **แสดงผลประเภทขยะ + ป๊อปอัพแจ้งเตือน** | `src/pages/ResultPage.jsx` |

## 🗑️ ประเภทขยะที่รองรับ

- 🍃 ขยะเปียก (`wet`)
- ♻️ ขยะรีไซเคิล (`recyclable`)
- ⚠️ ขยะอันตราย (`hazardous`)
- 🗑️ ขยะทั่วไป (`general`)

## 🛰️ สถาปัตยกรรมฮาร์ดแวร์ (WiFi + ESP32 3 ตัว)

ระบบคุยกันผ่าน **WiFi/WebSocket** โดยมี Raspberry Pi เป็น **WiFi Access Point** และเป็น
ศูนย์กลาง (WebSocket hub) ให้ทุกอุปกรณ์เชื่อมเข้ามาที่เดียว

```
Raspberry Pi (WiFi AP 192.168.50.1)
 ├─ scripts/setup-ap.sh   ตั้ง Pi เป็น hotspot (nmcli)
 ├─ scripts/ws-hub.js      WebSocket hub :8181  ← เว็บ React เกาะที่นี่
 └─ model_server.py        AI จำแนกขยะ :8000 (ไม่ยุ่ง GPIO แล้ว)

ESP32 เกาะ WiFi ของ Pi แล้วต่อ hub :8181 (node แยกด้วยฟิลด์ "node"):
 ├─ #1 esp32_node1_sensor  HC-SR04 ตรวจของวาง + HX711 load cell → "detected/cleared/weight"
 ├─ #2 esp32_node2_relay   คุมรีเลย์ 5 ตัว (4 ประเภทขยะ + ไฟกล้อง) ← รับคำสั่ง "relay"
 └─ #3 esp32_node3_bins    HC-SR04 x4 วัดระดับถัง + RGB LED x4 → "bins", ← รับ "leds"
```

**ตั้งค่า Pi ให้เป็น AP แล้วรันระบบ:**

```bash
sudo bash scripts/setup-ap.sh    # ครั้งเดียว — SSID=CapybaraBin PASS=capybara1234
npm run dev:all                  # vite + ws-hub + model_server พร้อมกัน
```

ในเฟิร์มแวร์ ESP32 แต่ละตัว ตั้ง `WIFI_SSID / WIFI_PASS / HUB_HOST(192.168.50.1)` ให้ตรง
กับ AP ของ Pi (ดูคอมเมนต์หัวไฟล์ `.ino` สำหรับการต่อสายและ GPIO)

> โปรโตคอลข้อความ: JSON บรรทัดละ message มีฟิลด์ `node` (`sensor`/`relay`/`bins`/`leds`)
> hub จะ broadcast ให้ทุกตัว แล้วแต่ละฝั่งกรอง `node` ของตัวเองเอง

## 🤖 การเชื่อมโมเดลจริง

ตอนนี้ใช้ตัวจำลองอยู่ที่ [`src/lib/classifyWaste.js`](src/lib/classifyWaste.js) — แทนที่ฟังก์ชัน `classifyWaste` ด้วยการเรียกโมเดลของคุณ โดยให้คืนค่า shape เดิม:

```js
{
  type: 'wet' | 'recyclable' | 'hazardous' | 'general',
  confidence: 0..1,
  hasFoodResidue: boolean,  // → ป๊อปอัพ "นำเศษอาหารออกก่อน"
  blurry: boolean           // → ป๊อปอัพ "กรุณาถ่ายใหม่"
}
```

ตัวอย่างการเชื่อม TensorFlow.js / API:

```js
export async function classifyWaste(imageDataUrl) {
  const res = await fetch('/api/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl })
  })
  return res.json()
}
```

## ✨ Flow การแจ้งเตือน

- ภาพ **ไม่ชัด** → ป๊อปอัพ "กรุณาถ่ายใหม่อีกครั้ง"
- มี **เศษอาหาร** ติดมา → ป๊อปอัพ "นำเศษอาหารออกก่อน"
- กด **เสร็จสิ้น** → ป๊อปอัพ "ขอบคุณ" แล้วกลับหน้าพร้อมใช้งาน
# websmartbin
