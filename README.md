# 🐹 Capybara Waste Sorter (websmartbin)

ถังขยะอัจฉริยะแบบคีออสก์ — ผู้ใช้วางขยะลงถาด ระบบถ่ายรูปเอง จำแนกประเภทด้วยโมเดล AI
แล้วบอกว่าควรทิ้งถังไหน พร้อมจุดไฟบอกถังและพูดด้วยเสียงมาสคอตคาปิบารา

ทำงานบน **Raspberry Pi 5** (คีออสก์ Firefox เต็มจอ) + **กล้อง USB** + **ESP32 3 ตัว**
เว็บเป็น **React + Vite + TailwindCSS** โมเดลรันด้วย **Python (Keras 3)** บน Pi เครื่องเดียวกัน

---

## 📑 สารบัญ

1. [ภาพรวมระบบ](#-ภาพรวมระบบ)
2. [การทำงานตั้งแต่ต้นจนจบ](#-การทำงานตั้งแต่ต้นจนจบ)
3. [โมเดล AI](#-โมเดล-ai)
4. [กล้องและไฟกล้อง](#-กล้องและไฟกล้อง)
5. [การใช้งานประจำวัน](#-การใช้งานประจำวัน)
6. [ค่าที่ปรับบ่อย](#-ค่าที่ปรับบ่อย)
7. [ติดตั้งบนเครื่องใหม่](#-ติดตั้งบนเครื่องใหม่)
8. [รันบนคอมทั่วไป (โหมด dev)](#-รันบนคอมทั่วไป-โหมด-dev)
9. [แก้ปัญหาที่เจอบ่อย](#-แก้ปัญหาที่เจอบ่อย)
10. [โครงสร้างไฟล์](#-โครงสร้างไฟล์)
11. [โปรโตคอลข้อความ](#-โปรโตคอลข้อความ)

---

## 🛰️ ภาพรวมระบบ

Pi เป็นทั้ง **WiFi Access Point**, **WebSocket hub** และ **เซิร์ฟเวอร์โมเดล** ในตัวเดียว
ESP32 ทุกตัวเกาะ WiFi ของ Pi แล้วคุยผ่าน hub ที่เดียว (แยกกันด้วยฟิลด์ `node` ใน JSON)

```
Raspberry Pi 5  (WiFi AP 192.168.50.1 — SSID: CapybaraBin)
 ├─ vite            :5173   เว็บ React (Firefox เปิดเต็มจอที่ localhost:5173)
 ├─ ws-hub.js       :8181   WebSocket hub — ตัวกลางของทุก node
 ├─ model_server.py :8000   /classify จำแนกขยะ, /camera คุมไฟกล้อง, /health
 ├─ กล้อง USB              → เบราว์เซอร์เปิดเอง (getUserMedia)
 └─ GPIO 24               → ไฟส่องกล้อง 1 ดวง (Pi คุมตรง ไม่ผ่าน ESP32)

ESP32 (เกาะ WiFi ของ Pi → ws://192.168.50.1:8181/)
 ├─ #1 esp32_node1_sensor  HC-SR04 x2 ตรวจมือ + HX711 ชั่งน้ำหนัก
 │                          → ส่ง detected / cleared / weight / camera-on
 ├─ #2 esp32_node2_relay   รีเลย์ 4 ตัว = ไฟบอกประเภทขยะ 4 ถัง  ← รับ classify / all_off
 └─ #3 esp32_node3_bins    HC-SR04 x4 วัดระดับถัง + LED 3 สี x4 → ส่ง levels, ← รับ leds
```

---

## 🔄 การทำงานตั้งแต่ต้นจนจบ

| # | เกิดอะไรขึ้น | ใครทำ |
|---|---|---|
| 1 | หน้าจอค้างที่หน้า "พร้อมใช้งาน" | `ReadyPage.jsx` |
| 2 | มีคนยื่นมือ/ของเข้ามา HC-SR04 เห็นติดกัน 3 รอบ → ส่ง `{"node":"camera","event":"on"}` | node #1 |
| 3 | hub รับแล้วยิง `POST /camera {"on":true}` → **ไฟกล้องติดทันที** (ไม่รอเบราว์เซอร์) | `ws-hub.js` → `model_server.py` |
| 4 | ยืนยันครบ `STABLE_READS` → ส่ง `detected` → เว็บเด้งเข้าหน้ากล้อง | node #1 → `App.jsx` |
| 5 | เอามือออก → node #1 ส่ง `cleared` (แต่ยัง**ส่งน้ำหนักต่ออีก 19 วิ**) | node #1 |
| 6 | เว็บเช็คตาชั่ง: มีของ > `MIN_ITEM_WEIGHT_G` ไหม | `CameraPage.jsx` |
| 6a | **ยังไม่มีของ** → ขึ้น "วางขยะได้เลยน้า" แล้ว poll รอ 15 วิ ถ้ายังไม่มี → "ไม่เจอขยะ" กลับหน้าแรก | `CameraPage.jsx` |
| 6b | **มีของ** → นับถอยหลัง 3 วิ บนจอ แล้วลั่นชัตเตอร์ | `CameraPage.jsx` |
| 7 | ครอปภาพตาม `CAMERA_ZOOM` → JPEG base64 → `POST /classify` | `classifyWaste.js` |
| 8 | โมเดลทายคลาส → แมปเป็นประเภทของแอป → ถ้ามั่นใจ < 40% ตีเป็น `general` | `model_server.py` |
| 9 | เทียบน้ำหนักกับ `FOOD_THRESHOLD_GRAMS` ของคลาสนั้น → ตัดสินว่ามีเศษอาหารไหม | `CameraPage.jsx` |
| 10 | หน้าผลลัพธ์: เสียงสำเร็จ → พูดประเภทขยะ → สั่ง**ไฟถังติด 20 วิ** (ข้ามถ้าถังเต็ม) | `ResultPage.jsx` → node #2 |
| 11 | ถ้าถังนั้นเต็ม (จาก node #3) → เตือนหลังบอกประเภทเสร็จ | `ResultPage.jsx` |
| 12 | จบรอบ → `all_off` ดับไฟทุกดวง + ปลดสิทธิ์ไฟคืนให้ node #1 → กลับหน้าแรก | `relay.js` |

**เส้นทางพิเศษ**

- **ภาพเบลอ / มีเศษอาหาร** → หน้าผลลัพธ์เด้ง popup ให้แก้ก่อน แล้วกลับหน้าแรก ไม่จุดไฟถัง
- **ยกเลิกกลางคัน** (วางไม่ทันใน 15 วิ) → `App.cancelCapture()` ยิง `all_off` เอง
  เพราะปกติหน้าผลลัพธ์เป็นตัวปิดรอบ ถ้าไม่ยิงไฟจะค้างจนหมดเวลา
- **ตาข่ายกันไฟค้าง** มี 3 ชั้น: เว็บยิง `all_off` → `CAMERA_AUTO_OFF_S` 25 วิ ที่ Pi →
  `WEB_HOLD_MAX_MS` 40 วิ ที่ node #1

---

## 🤖 โมเดล AI

ไฟล์ที่ใช้อยู่: **`public/bes4t.keras`** (MobileNetV3Large, Keras 3)

- input `224x224x3` **NHWC ค่าพิกเซลดิบ 0-255** (ชั้น `Rescaling` อยู่ในกราฟแล้ว)
- output softmax 6 คลาส ความเร็ว ~0.15 วินาที/ภาพ บน Pi 5 (CPU)

| คลาสของโมเดล | ประเภทในแอป | ถัง |
|---|---|---|
| `Battery` | `hazardous` | ขยะอันตราย 🔋 |
| `Bottle`, `Cans` | `recyclable` | รีไซเคิล ♻️ |
| `Food` | `wet` | ขยะเปียก 🍃 |
| `Foodpekage`, `General` | `general` | ขยะทั่วไป 🗑️ |

**ความมั่นใจต่ำ → ตีเป็น general** — `CONF_THRESHOLD = 0.40` ถ้าโมเดลมั่นใจต่ำกว่านี้
จะไม่เดาถัง แต่ส่งเป็น `general` แทน (ทิ้งผิดถังแย่กว่าทิ้งถังรวม) ตั้ง `CONF_THRESHOLD=0`
เพื่อปิดฟังก์ชันตอนวัดความแม่นของโมเดล

**เปลี่ยนโมเดล** — วางไฟล์ใน `public/` แล้วแก้ `MODEL_PATH` ใน `model_server.py`
เซิร์ฟเวอร์เลือก backend จากนามสกุลไฟล์ให้เอง:

| นามสกุล | backend | ต้องลง |
|---|---|---|
| `.keras` / `.h5` | Keras 3 | `tensorflow` |
| `.onnx` | onnxruntime | `onnxruntime` |
| `.pt` / `.pth` | PyTorch | `torch` + `torchvision` |

ชื่อคลาสอ่านจาก metadata ในไฟล์ก่อน ถ้าไม่มีจะ fallback ไปที่ `public/class_map.json`
(ไฟล์ `.keras` ไม่เก็บชื่อคลาส จึง**ต้อง**ให้ลำดับใน `class_map.json` ตรงกับตอนเทรน)
ถ้าจำนวนคลาสไม่ตรงกัน เซิร์ฟเวอร์จะไม่ยอมสตาร์ต แทนที่จะทายมั่ว

---

## 📷 กล้องและไฟกล้อง

**ไฟส่องกล้อง** ต่อกับ GPIO 24 ของ Pi โดยตรง (active-LOW) ไม่ผ่าน ESP32 เพราะต้องติดให้ไวที่สุด
`ws-hub.js` ยิง HTTP ให้ทันทีที่ node #1 เห็นของ — ไม่ต้องรอเบราว์เซอร์

**ความสว่างภาพ** — ไฟดวงนี้สว่างมากจนภาพไหม้ (วัดได้ 89% ของพิกเซลชนเพดาน 250+ โมเดล
เลยเห็นแต่พื้นขาว) และหรี่ที่ฮาร์ดแวร์ไม่ได้ `model_server.py` จึงกดความสว่างที่ตัวกล้อง
ผ่าน `v4l2-ctl` ให้เอง:

```
brightness  0 → -64      พิกเซลไหม้ 89% → 0%   (ความสว่างเฉลี่ย 238 → 147)
```

ตั้งให้ 2 จังหวะ: ตอนเซิร์ฟเวอร์สตาร์ต และซ้ำทุกครั้งที่จุดไฟกล้อง (ค่าจะหายถ้าถอด-เสียบ USB ใหม่)
กล้องที่ใช้ (EMEET C60E) **ไม่รับ** `exposure_time_absolute` — ตั้งแล้วภาพไม่เปลี่ยน จึงใช้
`brightness` เป็นหลัก และมี `CAMERA_GAMMA` ให้กดต่อถ้ายังสว่างไป

---

## 🖥️ การใช้งานประจำวัน

**เปิดเครื่อง** — เสียบไฟ Pi แล้วรอ ระบบขึ้นเองทั้งหมด (labwc autostart → `scripts/kiosk-start.sh`)
Firefox เปิดเต็มจอที่ `http://localhost:5173/` ไม่ต้องแตะคีย์บอร์ด

**ดู log** — `tail -f kiosk.log` (ล้างใหม่ทุกครั้งที่บูต) รวม log ของ vite + hub + model server

**รันเองด้วยมือ** (ตอนพัฒนา / หลังแก้โค้ด Python):

```bash
npm run dev:all      # vite + ws-hub + model_server พร้อมกัน
npm run dev          # เว็บอย่างเดียว
npm run dev:hub      # WebSocket hub อย่างเดียว
npm run dev:model    # เซิร์ฟเวอร์โมเดลอย่างเดียว
```

> แก้ไฟล์ในเว็บ (`src/`) ไม่ต้องรีสตาร์ต — Vite hot-reload ให้เอง
> แก้ `model_server.py` ต้องรีสตาร์ตโปรเซส Python เท่านั้น

**เช็คว่ายังดีอยู่ไหม**

```bash
curl -s http://localhost:8000/health          # {"ok":true,"classes":[...]}
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"on":true}' http://localhost:8000/camera   # ไฟกล้องต้องติด
```

**ปุ่มลัดสำหรับทดสอบโดยไม่ต้องมีฮาร์ดแวร์** (กดบนหน้าเว็บ)

| ปุ่ม | ผล |
|---|---|
| `D` | จำลอง `detected` — เด้งเข้าหน้ากล้อง |
| `C` | จำลอง `cleared` — เริ่มนับถอยหลังถ่าย |
| `1` `2` `3` `4` | สลับสถานะ "ถังเต็ม" ของ เปียก / รีไซเคิล / อันตราย / ทั่วไป |

---

## 🎛️ ค่าที่ปรับบ่อย

**ฝั่ง Pi — `model_server.py`** (ตั้งผ่าน env ตอนรันได้ทุกตัว)

| ค่า | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `MODEL_PATH` | `public/bes4t.keras` | ไฟล์โมเดล (แก้ในโค้ด) |
| `CONF_THRESHOLD` | `0.40` | ต่ำกว่านี้ตีเป็น general, `0` = ปิด |
| `CAMERA_BRIGHTNESS` | `-64` | ความสว่างกล้อง (-64..64) |
| `CAMERA_GAMMA` | ไม่ตั้ง | gamma (72..255) ใช้กดความสว่างต่อ |
| `CAMERA_PIN` | `24` | ขา GPIO ไฟกล้อง |
| `CAMERA_ACTIVE_LOW` | `1` | โมดูลรีเลย์/ไฟส่วนใหญ่เป็น active-LOW |
| `CAMERA_AUTO_OFF_S` | `25` | ไฟกล้องดับเองถ้าเงียบครบเท่านี้ |
| `MODEL_HOST` / `MODEL_PORT` | `0.0.0.0` / `8000` | ที่อยู่เซิร์ฟเวอร์ |

**ฝั่งเว็บ — `src/pages/CameraPage.jsx`**

| ค่า | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `MIN_ITEM_WEIGHT_G` | `3` | ต้องหนักเกินเท่านี้ถึงถือว่ามีของ (ถาดว่างอ่านได้ 1.4-1.7 ก.) |
| `CAPTURE_DELAY_MS` | `3000` | นับถอยหลังหลังเอามือออกก่อนถ่าย |
| `NO_ITEM_GRACE_MS` | `15000` | รอให้วางของนานสุดเท่าไรก่อนยอมแพ้ |
| `FOOD_THRESHOLD_GRAMS` | Bottle 80, Cans 38, Foodpekage 50 | หนักเกินนี้ = มีเศษอาหารติด |
| `CAMERA_ZOOM` | `0.5` | ครอปภาพก่อนส่งเข้าโมเดล |
| `MOVEMENT_THRESHOLD` | `6` | ความไวการตรวจจับความเคลื่อนไหวในเฟรม |

**ฝั่ง ESP32** (แก้ในไฟล์ `.ino` แล้วอัปโหลดใหม่)

| node | ค่า | ความหมาย |
|---|---|---|
| #1 | `BOX_MAX_CM` 40 | ระยะที่เซ็นเซอร์เห็นตอนกล่องว่าง — เกณฑ์เข้า (-12) / ออก (-6) ขยับตามเลขนี้ตัวเดียว |
| #1 | `NEAR_READS_PER_SENSOR` 2 | เซ็นเซอร์ตัวเดียวกันต้องเห็นใกล้ติดกันกี่ครั้งถึงเชื่อ |
| #1 | `STABLE_READS` 3 / `LIGHT_ON_READS` 1 | ยืนยัน detected/cleared กี่รอบ / รอกี่รอบถึงจุดไฟ |
| #1 | `WEIGHT_TAIL_MS` 19000 | ส่งน้ำหนักต่ออีกกี่ ms หลัง `cleared` (ต้องคลุม 15+3 วิของเว็บ) |
| #1 | `CALIBRATION_FACTOR` / `BASELINE` | คาลิเบรตตาชั่ง — **ต้องตั้งใหม่ทุกเครื่อง** |
| #2 | `CLASSIFY_ON_MS` 20000 | ไฟถังติดค้างกี่ ms |
| #2 | `RELAY_ACTIVE_LOW` true | รีเลย์ถูก ๆ ส่วนใหญ่ LOW = ติด |
| #3 | `BIN_DEPTH_CM` 50.0 / `FULL_CM` 5.0 | ความลึกถัง / เหลือระยะเท่านี้ = เต็ม 100% |

---

## 📦 ติดตั้งบนเครื่องใหม่

### 0. ของที่ต้องเตรียม

- Raspberry Pi 5 + Raspberry Pi OS (Trixie, 64-bit, เดสก์ท็อป **labwc**) + สาย LAN
- กล้อง USB (UVC) — ตัวที่ใช้อยู่คือ EMEET SmartCam C60E
- ไฟส่องกล้อง 1 ดวง + โมดูลรีเลย์/ทรานซิสเตอร์ ต่อกับ GPIO 24
- ESP32 3 บอร์ด, HC-SR04 x6, HX711 + load cell, รีเลย์ 4 ช่อง, LED 3 สี x4
- ลำโพง I2S (MAX98357A) ถ้าต้องการเสียงพูด

> **Pi มี wlan0 ตัวเดียว → เป็น AP กับต่อเน็ตพร้อมกันไม่ได้** ต้องใช้สาย LAN สำหรับอินเทอร์เน็ต
> และปิด autoconnect ของ WiFi เดิม: `nmcli con modify "<ชื่อ-wifi-เดิม>" connection.autoconnect no`

### 1. ติดตั้งซอฟต์แวร์บน Pi

```bash
git clone https://github.com/Intira-Wichitanurak/websmartbin.git
cd websmartbin
scripts/install.sh
```

สคริปต์จะจัดการให้ทั้งหมด: apt (node, firefox, ffmpeg, v4l-utils, lgpio, flask, pillow),
`npm install`, `pip install tensorflow`, แพตช์ `/boot/firmware/config.txt` (I2S + UART),
ติดตั้ง Firefox policy (อนุญาตกล้อง/เสียงอัตโนมัติ) และตั้ง autostart ของ labwc

ตัวเลือกเสริม — ลง backend อื่นเพิ่มเมื่อจะใช้โมเดลคนละสกุล:

```bash
WITH_TORCH=1 scripts/install.sh     # สำหรับโมเดล .pt / .pth (หนัก ~1.5GB)
WITH_ONNX=1  scripts/install.sh     # สำหรับโมเดล .onnx
```

### 2. ตั้ง Pi ให้เป็น WiFi AP

```bash
sudo bash scripts/setup-ap.sh       # SSID=CapybaraBin  PASS=capybara1234  IP=192.168.50.1
```

เปลี่ยนชื่อ/รหัสได้ด้วย `AP_SSID=... AP_PASS=... sudo -E bash scripts/setup-ap.sh`
(ถ้าเปลี่ยน ต้องแก้ในไฟล์ `.ino` ทั้ง 3 ตัวให้ตรงกันด้วย)

### 3. ใส่โมเดลกับไฟล์เสียง

```bash
cp <ที่เก็บโมเดล>/bes4t.keras  public/          # หรือโมเดลของคุณเอง
cp <ที่เก็บเสียง>/*.mp3        public/voice/    # ไม่มีก็ได้ ระบบจะใช้เสียงสังเคราะห์แทน
```

โมเดลชื่ออื่น → แก้ `MODEL_PATH` ใน `model_server.py` และอัปเดต `public/class_map.json`
ให้ชื่อ/ลำดับคลาสตรงกับตอนเทรน

### 4. แฟลช ESP32 (Arduino IDE)

- Board: **ESP32 Dev Module**, Library ที่ต้องลง: `WebSockets` (Links2004), `ArduinoJson`,
  `HX711` (Bogdan Necula — เฉพาะ node #1)
- แก้ `WIFI_SSID` / `WIFI_PASS` / `HUB_HOST` ในแต่ละ `.ino` ให้ตรงกับ AP ของ Pi
- อัปโหลดทีละตัว: `esp32_node1_sensor/`, `esp32_node2_relay/`, `esp32_node3_bins/`
- ต่อสายตามคอมเมนต์หัวไฟล์ของแต่ละ `.ino` (มีผังขาครบ) — **ECHO ของ HC-SR04 ทุกตัว
  ต้องผ่านตัวแบ่งแรงดัน 5V→3.3V**

> **จุดที่พลาดกันบ่อยที่สุด:** ESP32 core 3.x ต้องเรียก `WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK)`
> ก่อน `WiFi.begin()` ไม่งั้นเกาะ AP ของ NetworkManager ไม่ได้ อาการคือ `WiFi.status()` ค้างที่ 6
> ทั้งที่มือถือต่อ AP เดียวกันได้ปกติ — โค้ดในรีโปนี้ใส่ไว้ให้แล้วทั้ง 3 ตัว

### 5. คาลิเบรตตาชั่ง (node #1)

ค่าในโค้ดผูกกับ load cell ตัวเดิม ของใหม่ต้องหาเอง:

1. เปิด Serial Monitor ดูค่า raw ตอนถาดว่าง → ใส่เป็น `BASELINE`
2. วางของที่รู้น้ำหนัก (เช่น 500 ก.) อ่าน raw ใหม่ →
   `CALIBRATION_FACTOR = (raw - BASELINE) / น้ำหนักจริง`
3. อัปโหลดใหม่ แล้วตรวจว่าถาดว่างอ่านได้ใกล้ 0 (ของเดิมอยู่ที่ 1.4-1.7 ก.)

โค้ด**ไม่เรียก `tare()`** เพราะใช้ `BASELINE` แบบ absolute — ถ้าเรียกจะหักออฟเซ็ตซ้อนกัน

### 6. รีบูตแล้วตรวจ

```bash
sudo reboot
```

หลังบูตควรได้ตามนี้ครบทุกข้อ:

- [ ] Firefox ขึ้นเต็มจอที่หน้า "พร้อมใช้งาน" โดยไม่ถามสิทธิ์กล้อง
- [ ] `curl -s localhost:8000/health` ตอบ `{"ok":true,...}`
- [ ] `grep -a "\[hub\]" kiosk.log` เห็น ESP32 ต่อเข้ามาครบ 3 ตัว
- [ ] เอามือบังเซ็นเซอร์ → ไฟกล้องติดภายในราว 0.3 วินาที
- [ ] วางขยะแล้วเอามือออก → นับถอยหลัง 3 วิ → ได้ผลจำแนก + ไฟถังติด

---

## 💻 รันบนคอมทั่วไป (โหมด dev)

ไม่ต้องมี Pi หรือ ESP32 ก็เปิดดูหน้าเว็บได้ — GPIO/WebSocket จะ degrade เป็น no-op เอง

```bash
npm install
cp .env.example .env          # แล้วตั้ง VITE_SENSOR_ENABLED=false
npm run dev                   # http://localhost:5173
```

อยากลองโมเดลด้วยให้เปิดอีกเทอร์มินัล:

```bash
pip install tensorflow flask pillow      # backend ตามสกุลไฟล์โมเดล
python3 model_server.py
```

ใช้ปุ่มลัด `D` / `C` แทนเซ็นเซอร์ (ดูตารางปุ่มลัดด้านบน) ถ้าไม่มีเซิร์ฟเวอร์โมเดล
`classifyWaste()` จะ fallback เป็นผลจำลองให้เดินตาม flow ได้จนจบ

---

## 🔧 แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| ESP32 เกาะ WiFi ไม่ได้ (`status=6`) | ลืม `WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK)` ก่อน `WiFi.begin()` |
| ESP32 เกาะ WiFi ได้แต่ไม่ได้ IP | dnsmasq ของ NetworkManager ไม่ทำงาน → `sudo nmcli con down capybara-ap && sudo nmcli con up capybara-ap` |
| Pi ต่อเน็ตไม่ได้หลังเปิด AP | wlan0 ถูกใช้เป็น AP แล้ว — ต้องต่อเน็ตผ่านสาย LAN |
| Firefox ขึ้นหน้าเลือกโปรไฟล์ | โปรไฟล์คีออสก์อยู่ที่ `~/.mozilla/firefox-kiosk` — `kiosk-start.sh` จัดการให้แล้ว ถ้ายังขึ้นให้ลบไฟล์ `.parentlock` ในโฟลเดอร์นั้น |
| กล้องไม่ขึ้น / ถูกถามสิทธิ์ | policy หาย → `sudo cp scripts/firefox-policies.json /etc/firefox/policies/policies.json` |
| ภาพสว่างจ้า/ไหม้ | ค่ากล้องรีเซ็ต (ถอด-เสียบ USB) → รีสตาร์ต `model_server.py` หรือ `v4l2-ctl -d /dev/video0 --set-ctrl brightness=-64` |
| เซิร์ฟเวอร์โมเดลไม่ขึ้น | อ่าน error ใน `kiosk.log` — มักเป็นจำนวนคลาสใน `class_map.json` ไม่ตรงกับโมเดล หรือยังไม่ได้ลง backend ของสกุลไฟล์นั้น |
| ไฟกล้องค้าง | ปกติดับเองใน 25 วิ ถ้าไม่ดับ → `curl -X POST -H 'Content-Type: application/json' -d '{"on":false}' localhost:8000/camera` |
| หน้าจอเด้ง "ไม่เจอขยะ" ทั้งที่มีของ | น้ำหนักไม่ถึง `MIN_ITEM_WEIGHT_G` หรือตาชั่งเพี้ยน → คาลิเบรตใหม่ |
| ระบบติดเอง/ไฟกล้องติดทั้งที่ไม่มีคน | เกณฑ์ระยะไปนั่งทับค่าที่เห็นตอนกล่องว่าง — ดู `cm1`/`cm2` จาก `grep -a '"event":"cleared"' kiosk.log \| tail` ตอนกล่องว่าง ได้เท่าไรตั้ง `BOX_MAX_CM` เท่านั้นใน node #1 |
| พอร์ต 8000/8181 ถูกใช้อยู่ | มีโปรเซสเดิมค้าง → `pkill -f model_server.py` / `pkill -f ws-hub.js` |

---

## 🗂️ โครงสร้างไฟล์

```
src/
 ├─ App.jsx                 สลับหน้า, bridge ระดับถัง, ปุ่มลัด dev
 ├─ pages/ReadyPage.jsx     หน้าพร้อมใช้งาน
 ├─ pages/CameraPage.jsx    ถ่ายภาพ: ด่านน้ำหนัก, นับถอยหลัง, เรียกโมเดล
 ├─ pages/ResultPage.jsx    ผลลัพธ์: พูด, จุดไฟถัง, เตือนถังเต็ม/เศษอาหาร
 ├─ lib/classifyWaste.js    เรียก /classify + ตาราง WASTE_TYPES (ป้าย/สี/คำแนะนำ)
 ├─ lib/relay.js            ไฟถัง (WebSocket) + ไฟกล้อง (HTTP)
 ├─ lib/sensor.js           ตัวเชื่อม WebSocket hub + น้ำหนักล่าสุด
 ├─ lib/binStatus.js        สถานะถังเต็ม (ป้อนจาก node #3 ผ่าน App.jsx)
 └─ lib/sounds.js           เสียงเอฟเฟกต์ + เสียงพูด (mp3 หรือ TTS)

scripts/
 ├─ install.sh              ติดตั้งครั้งเดียวบน Pi เครื่องใหม่
 ├─ setup-ap.sh             ตั้ง Pi เป็น WiFi AP (nmcli)
 ├─ kiosk-start.sh          ตัวสตาร์ตตอนบูต (backend + Firefox kiosk)
 ├─ ws-hub.js               WebSocket hub + ส่งต่อคำสั่งไฟกล้อง
 └─ firefox-policies.json   policy อนุญาตกล้อง/เสียงอัตโนมัติ

model_server.py             เซิร์ฟเวอร์โมเดล + คุมไฟกล้อง + ตั้งค่าความสว่างกล้อง
public/bes4t.keras          โมเดลที่ใช้งานอยู่
public/class_map.json       ชื่อคลาส + การแมปเป็นประเภทขยะ
esp32_node1_sensor/         เฟิร์มแวร์ ESP32 #1 (เซ็นเซอร์ + ตาชั่ง)
esp32_node2_relay/          เฟิร์มแวร์ ESP32 #2 (ไฟบอกประเภทขยะ)
esp32_node3_bins/           เฟิร์มแวร์ ESP32 #3 (ระดับถัง + LED)
```

---

## 📡 โปรโตคอลข้อความ

JSON บรรทัดละ 1 ข้อความผ่าน `ws://192.168.50.1:8181/` — hub broadcast ให้ทุกตัวที่ต่ออยู่
(ยกเว้นผู้ส่ง) แล้วแต่ละฝั่งกรองเอาเฉพาะ `node` ของตัวเอง

| ทิศทาง | ข้อความ | ความหมาย |
|---|---|---|
| #1 → | `{"node":"sensor","event":"detected","grams":123.4}` | เห็นของ/มือ |
| #1 → | `{"node":"sensor","event":"cleared","grams":0.5}` | ไม่เห็นแล้ว |
| #1 → | `{"node":"sensor","event":"weight","grams":123.4}` | น้ำหนักทุก 500ms (+ ต่ออีก 19 วิหลัง cleared) |
| #1 → | `{"node":"camera","event":"on"}` | ขอให้จุดไฟกล้อง (hub ยิง `/camera` ต่อ) |
| → #2 | `{"node":"relay","event":"classify","type":"wet"}` | จุดไฟถังที่ตรง ดับตัวอื่น (auto-off 20 วิ) |
| → #2 | `{"node":"relay","event":"all_off"}` | ดับไฟถังทุกดวง |
| #3 → | `{"node":"bins","event":"levels","bins":[{"i":0,"cm":18.2,"pct":40,"color":"green"}]}` | ระดับขยะแต่ละถัง |
| → #3 | `{"node":"leds","event":"set","leds":[{"i":0,"color":"red"}]}` | บังคับสี LED |
| → #3 | `{"node":"leds","event":"auto"}` | กลับไปให้ LED ตามระดับถังเอง |

HTTP ของ `model_server.py`

| endpoint | body | ผลลัพธ์ |
|---|---|---|
| `POST /classify` | `{"image":"data:image/jpeg;base64,..."}` | `{type, modelClass, confidence, lowConfidence, probs, classes, idx}` |
| `POST /camera` | `{"on":true}` | เปิด/ปิดไฟกล้อง (GPIO 24) |
| `GET /health` | — | `{ok, classes, device}` |

---

ทำด้วย 💖 โดยน้องคาปิ
