/*
Capybara Waste Sorter — ESP32 NODE #1: presence + weight  (WiFi / WebSocket)

หน้าที่:
- HC-SR04 x2          → ตรวจมือ 2 จุดให้ครอบคลุม
                        ยิงสลับตัวรอบละตัว (กันคลื่นชนกันเอง) ตัวใดตัวหนึ่งเห็นใกล้กว่า
                        PRESENT_ENTER_CM ติดกันพอ = มีมือ → detected (ปลุกกล้อง)
                        ทั้ง 2 ตัวไกลกว่า PRESENT_EXIT_CM = ว่าง → cleared (เว็บถ่าย)
- HX711 + Load cell   → วัดน้ำหนัก (เช็ค "เศษอาหาร")
- เชื่อม WiFi ของ Pi (AP) แล้วส่ง JSON event ไป WebSocket hub บน Pi

ส่ง (node="sensor"):
{"node":"sensor","event":"detected","grams":123.4,"cm1":21.3,"cm2":999}  // เห็นของ
{"node":"sensor","event":"cleared","grams":0.5,"cm1":999,"cm2":999}      // ไม่เห็นแล้ว
                                                      // cm1/cm2 = ระยะล่าสุดของแต่ละตัว
                                                      // (ไว้ไล่ปัญหาจาก log ฝั่ง Pi)
{"node":"sensor","event":"weight","grams":123.4}      // ทุก 500ms ระหว่างมีของ + ต่ออีก
                                                      // WEIGHT_TAIL_MS หลัง cleared
{"node":"camera","event":"on"}                        // เห็นมือรอบแรก → ไฟกล้องติดเลย
                                                      // (ไม่รอ STABLE_READS; hub บน Pi
                                                      //  ยิง /camera ให้ ไม่ผ่านเบราว์เซอร์)
                                                      // node นี้ส่งแต่ "เปิด" การดับเป็น
                                                      // หน้าที่ของ Pi (CAMERA_AUTO_OFF_S)
                                                      // และเว็บ (relayAllOff)

Library ที่ต้องติดตั้ง (Library Manager):
- HX711 by Bogdan Necula
- WebSockets by Markus Sattler  (arduinoWebSockets / Links2004)
- ArduinoJson by Benoit Blanchon

การต่อสาย (ECHO ทุกตัวผ่านตัวแบ่งแรงดัน/R 1k 5V→3.3V):
HC-SR04 #1  TRIG → GPIO5    ECHO → GPIO18
HC-SR04 #2  TRIG → GPIO27   ECHO → GPIO26
HC-SR04 VCC → 5V (VIN), GND → GND (ทั้ง 2 ตัว)
HX711  DT → GPIO21, SCK → GPIO22, VCC → 5V/3V3, GND → GND
Load cell 4 สาย → HX711 (E+/E-/A+/A-)

Calibration (ค่าล่าสุดที่ tune ไว้):
CALIBRATION_FACTOR = 1017.94 ; BASELINE = 1075295 (แบบ absolute, ไม่เรียก tare() ซ้ำ)
weight_g = (raw - BASELINE) / CALIBRATION_FACTOR
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <HX711.h>

// ---------- WiFi / hub ----------
#define WIFI_SSID  "CapybaraBin"
#define WIFI_PASS  "capybara1234"
#define HUB_HOST   "192.168.50.1"
#define HUB_PORT   8181
#define HUB_PATH   "/"

WebSocketsClient ws;
bool wsConnected = false;

// ---------- presence: HC-SR04 x2 ----------
const int   TRIG_PIN     = 5;     // ตัวที่ 1
const int   ECHO_PIN     = 18;
const int   TRIG_PIN2    = 27;    // ตัวที่ 2
const int   ECHO_PIN2    = 26;
// เกณฑ์ระยะ — อิงจากความกว้างกล่อง ไม่ใช่เลขลอย ๆ
//
// กล่องกว้างสุด 40 ซม. แปลว่าตอนไม่มีอะไรเลย เซ็นเซอร์ยังเห็นผนัง/พื้นฝั่งตรงข้าม
// ที่ราว ๆ 40 ซม. อยู่ดี (ไม่ใช่ 999) เกณฑ์เดิม PRESENT_CM = 40.0 จึงนั่งทับ "ค่าตอนว่าง"
// พอดี ค่าที่อ่านได้แกว่ง ±2-3 ซม. ตามปกติของ HC-SR04 ก็ข้ามเส้นไปมาเอง = detected/
// cleared สลับกันรัวทั้งที่ไม่มีใครมา (log จริงเจอ 78 รอบ ถ่ายจริง 0 รอบ)
//
// คุมด้วยเลขเดียวคือ BOX_MAX_CM แล้วเว้นระยะปลอดภัยจากผนังลงมา:
//   เข้า  = ต้องใกล้กว่าผนัง 12 ซม. ขึ้นไป (มือ/ของจริงเท่านั้นที่เข้ามาถึง)
//   ออก   = ห่างจากผนังไม่เกิน 6 ซม. ก็ถือว่าว่างแล้ว
// ช่วงระหว่างสองเส้นคงสถานะเดิมไว้ (hysteresis)
//
// วิธีจูน: แฟลชแล้วเปิดกล่องให้ว่าง ดูค่า cm1/cm2 ที่ติดมากับ event ใน kiosk.log
//   grep -a '"event":"cleared"' kiosk.log | tail -5
// ได้เท่าไรก็ตั้ง BOX_MAX_CM เท่านั้น (ปัดขึ้นเล็กน้อย) ที่เหลือขยับตามให้เอง
const float BOX_MAX_CM       = 40.0;               // ระยะที่เห็นตอนกล่องว่าง (ผนัง/พื้น)
const float PRESENT_ENTER_CM = BOX_MAX_CM - 12.0;  // 28 ซม. — ใกล้กว่านี้ = เริ่มนับว่ามีของ
const float PRESENT_EXIT_CM  = BOX_MAX_CM -  6.0;  // 34 ซม. — ไกลกว่านี้ = ว่าง
const float MIN_VALID_CM     = 3.0;   // ต่ำกว่านี้ = ต่ำกว่าสเปกเซ็นเซอร์ = สัญญาณกวน ทิ้ง

const int   STABLE_READS = 3;     // อ่านได้ค่าเดิมติดกันกี่รอบถึงเชื่อ (x100ms)
// เซ็นเซอร์ตัวหนึ่ง ๆ ต้องเห็นใกล้ติดกันกี่ครั้งของตัวเองถึงจะนับว่า "ใกล้จริง"
// (ยิงสลับตัวรอบละตัว → 2 ครั้งของตัวเดียวกัน = 200ms) กันค่าหลอนเดี่ยว ๆ
const int   NEAR_READS_PER_SENSOR = 2;
// present ขึ้นแล้วรอกี่รอบถึงจุดไฟ — ด่านกรองอยู่ที่ NEAR_READS_PER_SENSOR แล้ว
// ตรงนี้จึงเป็น 1 เพื่อให้ไฟยังติดไว
const int   LIGHT_ON_READS = 1;

// ---------- HX711 load cell ----------
const int   HX711_DT           = 21;
const int   HX711_SCK          = 22;
const float CALIBRATION_FACTOR = 1017.94;
const long  BASELINE           = 1075295;
HX711 scale;

// ---------- timing ----------
const unsigned long IR_READ_INTERVAL     = 100;
const unsigned long WEIGHT_READ_INTERVAL = 300;
const unsigned long WEIGHT_BROADCAST_MS  = 500;
// ส่งน้ำหนักต่ออีกเท่านี้หลัง cleared — ถ้าหยุดส่งตอน cleared เว็บจะถือค่าแช่แข็งไว้
// แล้วมองไม่เห็นว่ามีของมาวางทีหลัง
// ต้องคลุมสองช่วงนี้ของฝั่งเว็บ (ดู src/pages/CameraPage.jsx):
//   NO_ITEM_GRACE_MS 15s = ช่วงรอให้คนวางของ ก่อนยอมแพ้กลับหน้าแรก
//   CAPTURE_DELAY_MS  3s = นับถอยหลังก่อนถ่าย แล้วเช็คซ้ำว่าของยังอยู่ไหม
// ถ้าค่านี้สั้นกว่า จะมีช่วงตาบอดที่วางของแล้วระบบไม่รู้เรื่อง
const unsigned long WEIGHT_TAIL_MS       = 19000;

// ---------- ความเป็นเจ้าของไฟกล้อง ----------
// IDLE  ไฟดับ พร้อมจุด — เห็นของรอบแรกเมื่อไหร่จุดทันที
// ARMED ESP จุดไฟแล้วแต่ยังไม่ครบ STABLE_READS — ยังเป็นของ ESP จึงมีสิทธิ์สั่งดับ
// WEB   ครบ STABLE_READS (detected) แล้ว — ส่งมอบให้เว็บ ESP ห้ามแตะไฟเด็ดขาด
//       จนกว่าเว็บจะปิดกล้องแล้วส่ง all_off กลับมา
//
// ที่ต้องมีสถานะ WEB เพราะหลัง cleared เว็บยังนับถอยหลังอีก 3 วิก่อนถ่าย ถ้า ESP
// ยังถือสิทธิ์อยู่ ค่าอ่านหลอนช่วงนั้นจะทำให้มันดับไฟใส่ตอนชัตเตอร์กำลังจะลั่น
enum LightOwner { LIGHT_IDLE, LIGHT_ARMED, LIGHT_WEB };
const unsigned long WEB_HOLD_MAX_MS = 40000;   // กัน WEB ค้างถ้า all_off ไม่มา

LightOwner lightOwner = LIGHT_IDLE;
int   presentReads  = 0;       // นับรอบที่เห็นของติดกัน → ครบ LIGHT_ON_READS แล้วจุดไฟ
int   absentReads   = 0;       // นับรอบที่ของหายไปตอนยัง ARMED → ครบ STABLE_READS แล้วดับ
unsigned long webSince = 0;

bool  currentState  = false;
int   sameReads     = 0;
// ระยะล่าสุดของเซ็นเซอร์แต่ละตัว + ตัวนับ "เห็นใกล้ติดกัน" ของตัวนั้น ๆ
// (ยิงทีละตัวสลับรอบ ค่าจึงอัปเดตคนละจังหวะ ต้องเก็บไว้ทั้งคู่)
float cmLast[2]     = { 999.0, 999.0 };
int   nearReads[2]  = { 0, 0 };
int   pingIdx       = 0;       // รอบนี้ยิงตัวไหน (สลับ 0/1 ทุกรอบ)
bool  present       = false;   // สถานะ hysteresis — คงค่าไว้ระหว่างรอบ
float currentWeight = 0.0;
unsigned long lastRead = 0, lastWeightRead = 0, lastWeightSend = 0, lastDbg = 0;
unsigned long clearedAt = 0;   // เวลาที่ส่ง cleared ล่าสุด — ใช้คุมหางการส่งน้ำหนัก

// ---------- HC-SR04 read → cm (ระบุขาได้ ใช้ได้ทั้ง 2 ตัว) ----------
float readDistanceCm(int trig, int echo) {
  digitalWrite(trig, LOW);  delayMicroseconds(2);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long us = pulseIn(echo, HIGH, 30000);       // timeout 30ms (~5m)
  if (us == 0) return 999.0;                  // ไม่มี echo = ไกล/ว่าง
  float cm = us / 58.0;
  if (cm < MIN_VALID_CM) return 999.0;        // ใกล้เกินสเปก = เสียงกวน ไม่ใช่ของจริง
  return cm;
}

float readWeight() {
  if (!scale.is_ready()) return currentWeight;
  long raw = scale.get_value(3);
  float g = (raw - BASELINE) / CALIBRATION_FACTOR;
  if (g < 0 && g > -2) g = 0;
  return g;
}

void sendEvent(const char* event) {
  StaticJsonDocument<160> doc;
  doc["node"]  = "sensor";
  doc["event"] = event;
  doc["grams"] = round(currentWeight * 10) / 10.0;
  // แนบระยะล่าสุดของทั้ง 2 ตัวไปด้วย — ตอนไล่ปัญหา "ติดเอง" ไม่มีค่านี้ใน log
  // เลยยืนยันไม่ได้ว่าตอนนั้นเซ็นเซอร์เห็นอะไร (Serial ดูไม่ได้ บอร์ดอยู่บน WiFi)
  doc["cm1"]   = round(cmLast[0] * 10) / 10.0;
  doc["cm2"]   = round(cmLast[1] * 10) / 10.0;
  char buf[160];
  size_t n = serializeJson(doc, buf);
  ws.sendTXT(buf, n);
  Serial.print("-> "); Serial.println(buf);
}

// ไฟกล้อง — ส่งแยกจาก sendEvent() เพราะใช้ node="camera" ให้ hub บน Pi ยิง GPIO
// ต่อได้ทันที (เว็บกรอง node นี้ทิ้ง — ดู src/lib/sensor.js)
//
// สั่งดับได้เฉพาะตอนยังเป็น LIGHT_ARMED เท่านั้น (ดู lightOwner)
void sendCameraLight(bool on) {
  const char* msg = on ? "{\"node\":\"camera\",\"event\":\"on\"}"
                       : "{\"node\":\"camera\",\"event\":\"off\"}";
  ws.sendTXT(msg);
  Serial.print("-> "); Serial.println(msg);
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)      { wsConnected = true;  Serial.println("[ws] connected"); }
  else if (type == WStype_DISCONNECTED) { wsConnected = false; Serial.println("[ws] disconnected"); }
  else if (type == WStype_TEXT && lightOwner == LIGHT_WEB && len < 256) {
    // เว็บส่ง {"node":"relay","event":"all_off"} ตอนออกจากหน้าผลลัพธ์ = ปิดกล้องแล้ว
    // (ดู relayAllOff ใน src/lib/relay.js) — จบรอบ รับไฟกลับมาเป็นของ ESP
    char buf[256];
    memcpy(buf, payload, len); buf[len] = '\0';
    if (strstr(buf, "all_off")) {
      lightOwner = LIGHT_IDLE;
      Serial.println("[light] all_off จากเว็บ — จบรอบ กลับสู่ IDLE");
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN,  OUTPUT);
  pinMode(ECHO_PIN,  INPUT);
  pinMode(TRIG_PIN2, OUTPUT);
  pinMode(ECHO_PIN2, INPUT);

  scale.begin(HX711_DT, HX711_SCK);

  // หมายเหตุ: ไม่เรียก scale.tare() แล้ว
  // เพราะใช้ BASELINE (ค่า raw แบบ absolute) จากการคาลิเบรตแยกต่างหากแทน
  // ถ้าเรียก tare() ซ้ำ จะหักออฟเซ็ตซ้อนกับ BASELINE ทำให้ค่าน้ำหนักผิดเพี้ยนมหาศาล
  Serial.println("HX711: ready (ใช้ BASELINE คงที่)");

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                    // ปิด power-save — กันหลุด/ต่อไม่ติด
  WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);  // ยอมรับ WPA-PSK — แก้ ESP32 core 3.x ค้าง status=6 กับ NM AP
  WiFi.disconnect(true, true);             // ล้าง state เก่าใน NVS
  delay(200);
  Serial.printf("[wifi] joining '%s' ...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // พิมพ์ status code จริงทุกวินาที (แทนจุดๆ) + ลอง begin ใหม่ถ้าเกิน 12s
  //   status: 1=NO_SSID_AVAIL(หา AP ไม่เจอ) 4=CONNECT_FAILED(รหัส/auth ผิด)
  //           6=DISCONNECTED(กำลังลอง) 3=CONNECTED
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.printf("[wifi] status=%d rssi=%d\n", WiFi.status(), WiFi.RSSI());
    if (millis() - t0 > 12000) {
      Serial.println("[wifi] ยังไม่ติด — begin ใหม่...");
      WiFi.disconnect(true, true);
      delay(200);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      t0 = millis();
    }
  }
  Serial.printf("[wifi] connected, IP=%s\n", WiFi.localIP().toString().c_str());

  ws.begin(HUB_HOST, HUB_PORT, HUB_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
}

void loop() {
  ws.loop();
  unsigned long now = millis();

  // presence poll (เร็ว) — ยิงทีละตัวสลับรอบ + hysteresis 28/34 ซม. (อิง BOX_MAX_CM)
  if (now - lastRead >= IR_READ_INTERVAL) {
    lastRead = now;

    // ยิงทีละตัว สลับรอบ — เดิมยิงตัวที่ 1 แล้วต่อตัวที่ 2 ทันทีในรอบเดียวกัน
    // คลื่นของตัวแรกยังก้องอยู่ ตัวที่สองรับเข้าไปเป็นระยะสั้นปลอม ๆ ได้
    // (โค้ดใช้ OR ปลอมตัวเดียวก็พอทำให้ทั้งระบบเด้ง) สลับรอบแล้วห่างกัน 100ms
    pingIdx = 1 - pingIdx;
    cmLast[pingIdx] = (pingIdx == 0) ? readDistanceCm(TRIG_PIN,  ECHO_PIN)
                                     : readDistanceCm(TRIG_PIN2, ECHO_PIN2);

    // นับเฉพาะตัวที่เพิ่งอ่าน — ต้องเห็นใกล้ติดกันเองหลายครั้งถึงเชื่อ
    // โซนกลาง (28-34) ค่อย ๆ ลดลงทีละ 1 ไม่ล้างทันทีและไม่แช่ค้าง — ของที่ค้างอยู่
    // แถวเส้นแบ่งจึงคลายออกเองได้ ส่วนค่าที่แกว่งเข้า ๆ ออก ๆ จะไม่มีวันนับถึงเกณฑ์
    if (cmLast[pingIdx] < PRESENT_ENTER_CM) {
      // เพดานต่ำ ๆ สำคัญ: ถ้าปล่อยให้นับสูงลิ่ว พอคนถอยไปยืนโซนกลาง (28-34)
      // ต้องรอ decay ทีละ 1 หลายวินาทีกว่าจะปล่อย cleared — เพดาน 4 ปล่อยใน ~1 วิ
      if (nearReads[pingIdx] < NEAR_READS_PER_SENSOR + 2) nearReads[pingIdx]++;
    } else if (cmLast[pingIdx] > PRESENT_EXIT_CM) {
      nearReads[pingIdx] = 0;
    } else if (nearReads[pingIdx] > 0) {
      nearReads[pingIdx]--;
    }

    bool near = (nearReads[0] >= NEAR_READS_PER_SENSOR) ||
                (nearReads[1] >= NEAR_READS_PER_SENSOR);
    bool far  = (nearReads[0] == 0) && (nearReads[1] == 0);
    if (near)      present = true;
    else if (far)  present = false;   // อยู่ระหว่างกลาง = คงสถานะเดิม (hysteresis)

    // debug: พิมพ์ระยะทั้ง 2 ตัว + น้ำหนัก ทุก 500ms
    if (now - lastDbg >= 500) {
      lastDbg = now;
      Serial.printf("[sr04] cm1=%.1f(%d)  cm2=%.1f(%d)  w=%.1f g  %s\n",
                    cmLast[0], nearReads[0], cmLast[1], nearReads[1],
                    currentWeight, present ? "PRESENT" : "empty");
    }

    // ไฟกล้อง — เดินตาม lightOwner (ดูคำอธิบายสถานะด้านบน)
    if (present) presentReads++; else presentReads = 0;

    if (lightOwner == LIGHT_IDLE) {
      if (presentReads >= LIGHT_ON_READS) {           // เห็นติดกันพอแล้ว → จุดไฟ
        lightOwner  = LIGHT_ARMED;
        absentReads = 0;
        sendCameraLight(true);
      }
    } else if (lightOwner == LIGHT_ARMED) {
      if (present) {
        absentReads = 0;
      } else if (++absentReads >= STABLE_READS) {     // หายครบ STABLE_READS → ของปลอม ดับทิ้ง
        lightOwner = LIGHT_IDLE;
        sendCameraLight(false);
      }
    } else if (now - webSince >= WEB_HOLD_MAX_MS) {   // LIGHT_WEB ค้างนานผิดปกติ
      lightOwner = LIGHT_IDLE;                        // (เว็บปิด/ค้าง ไม่ส่ง all_off)
      Serial.println("[light] WEB ค้างเกินกำหนด — ปลดเองกันตาย");
    }

    if (present == currentState) {
      sameReads = 0;
    } else if (++sameReads >= STABLE_READS) {
      currentState = present;
      sameReads = 0;
      if (currentState && lightOwner == LIGHT_ARMED) {  // ยืนยันแล้ว → ส่งมอบให้เว็บ
        lightOwner = LIGHT_WEB;
        webSince   = now;
      }
      if (!currentState) clearedAt = now;
      sendEvent(currentState ? "detected" : "cleared");
    }
  }

  // weight poll (ช้ากว่า)
  if (now - lastWeightRead >= WEIGHT_READ_INTERVAL) {
    lastWeightRead = now;
    currentWeight = readWeight();
  }

  // ส่งน้ำหนักเป็นระยะขณะมีของวาง + ต่ออีก WEIGHT_TAIL_MS หลังเอามือออก
  // (ช่วงหางคือตอนที่เว็บนับถอยหลังแล้วเช็คซ้ำก่อนลั่นชัตเตอร์ ต้องมีค่าสด ๆ ให้ดู)
  bool sendWeight = currentState || (clearedAt && now - clearedAt < WEIGHT_TAIL_MS);
  if (sendWeight && now - lastWeightSend >= WEIGHT_BROADCAST_MS) {
    lastWeightSend = now;
    sendEvent("weight");
  }
}
