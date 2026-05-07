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
