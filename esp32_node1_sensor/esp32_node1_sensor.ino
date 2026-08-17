/*
Capybara Waste Sorter — ESP32 NODE #1: presence + weight  (WiFi / WebSocket)

หน้าที่:
- HC-SR04 x2          → ตรวจมือ 2 จุดให้ครอบคลุม
                        ตัวใดตัวหนึ่ง < PRESENT_CM = มีมือ → detected (ปลุกกล้อง)
                        ทั้ง 2 ตัว >= PRESENT_CM = ว่าง → cleared (เว็บนับถอยหลังแล้วถ่าย)
- HX711 + Load cell   → วัดน้ำหนัก (เช็ค "เศษอาหาร")
- เชื่อม WiFi ของ Pi (AP) แล้วส่ง JSON event ไป WebSocket hub บน Pi

ส่ง (node="sensor"):
{"node":"sensor","event":"detected","grams":123.4}   // เห็นของ + น้ำหนักล่าสุด
{"node":"sensor","event":"cleared","grams":0.5}       // ไม่เห็นของแล้ว
{"node":"sensor","event":"weight","grams":123.4}      // ส่งซ้ำทุก 500ms ระหว่างมีของ
{"node":"camera","event":"on"}                        // เห็นมือรอบแรก → ไฟกล้องติดเลย
                                                      // (ไม่รอ STABLE_READS; hub บน Pi
                                                      //  ยิง /camera ให้ ไม่ผ่านเบราว์เซอร์)
{"node":"camera","event":"off"}                       // มือหายก่อนครบ STABLE_READS
                                                      // (โบกผ่าน) → ไม่มี detected ตามมา
                                                      // เลยต้องดับไฟเอง กันไฟค้าง
                                                      // ถ้า detected เกิดแล้ว การดับไฟ
                                                      // เป็นของเว็บ (relayAllOff)

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
const float PRESENT_CM   = 40.0;  // ตัวใดตัวหนึ่ง < ค่านี้ = มีมือ; ทั้งคู่ >= = ว่าง
const int   STABLE_READS = 5;

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

bool  currentState  = false;
int   sameReads     = 0;
bool  lightHintSent = false;   // ยิงไฟกล้องไปแล้วรอบนี้? (รีเซ็ตตอน cleared)
int   abortReads    = 0;      // นับรอบที่มือหายทั้งที่ยังไม่ทัน detected → สั่งดับไฟ
float currentWeight = 0.0;
unsigned long lastRead = 0, lastWeightRead = 0, lastWeightSend = 0, lastDbg = 0;

// ---------- HC-SR04 read → cm (ระบุขาได้ ใช้ได้ทั้ง 2 ตัว) ----------
float readDistanceCm(int trig, int echo) {
  digitalWrite(trig, LOW);  delayMicroseconds(2);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long us = pulseIn(echo, HIGH, 30000);       // timeout 30ms (~5m)
  if (us == 0) return 999.0;                  // ไม่มี echo = ไกล/ว่าง
  return us / 58.0;
}

float readWeight() {
  if (!scale.is_ready()) return currentWeight;
  long raw = scale.get_value(3);
  float g = (raw - BASELINE) / CALIBRATION_FACTOR;
  if (g < 0 && g > -2) g = 0;
  return g;
}

void sendEvent(const char* event) {
  StaticJsonDocument<96> doc;
  doc["node"]  = "sensor";
  doc["event"] = event;
  doc["grams"] = round(currentWeight * 10) / 10.0;
  char buf[96];
  size_t n = serializeJson(doc, buf);
  ws.sendTXT(buf, n);
  Serial.print("-> "); Serial.println(buf);
}

// ไฟกล้อง — ส่งแยกจาก sendEvent() เพราะใช้ node="camera" ให้ hub บน Pi ยิง GPIO
// ต่อได้ทันที (เว็บกรอง node นี้ทิ้ง — ดู src/lib/sensor.js)
void sendCameraLight(bool on) {
  const char* msg = on ? "{\"node\":\"camera\",\"event\":\"on\"}"
                       : "{\"node\":\"camera\",\"event\":\"off\"}";
  ws.sendTXT(msg);
  Serial.print("-> "); Serial.println(msg);
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)      { wsConnected = true;  Serial.println("[ws] connected"); }
  else if (type == WStype_DISCONNECTED) { wsConnected = false; Serial.println("[ws] disconnected"); }
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

  // presence poll (เร็ว) — อ่าน 2 ตัว: ตัวใดตัวหนึ่ง < PRESENT_CM = มีมือ
  if (now - lastRead >= IR_READ_INTERVAL) {
    lastRead = now;
    float cm1 = readDistanceCm(TRIG_PIN,  ECHO_PIN);
    float cm2 = readDistanceCm(TRIG_PIN2, ECHO_PIN2);
    bool present = (cm1 < PRESENT_CM) || (cm2 < PRESENT_CM);

    // debug: พิมพ์ระยะทั้ง 2 ตัว + น้ำหนัก ทุก 500ms
    if (now - lastDbg >= 500) {
      lastDbg = now;
      Serial.printf("[sr04] cm1=%.1f  cm2=%.1f  w=%.1f g  %s\n",
                    cm1, cm2, currentWeight, present ? "PRESENT" : "empty");
    }

    // ไฟกล้อง: ยิงตั้งแต่รอบแรกที่เห็นมือ ไม่รอ STABLE_READS
    // ไฟติดพลาดสักครั้งไม่เสียหาย แต่ถ่ายผิดจังหวะเสียหายกว่า — เกณฑ์สองอย่างนี้
    // จึงแยกกัน: detected/cleared ยังกันเด้งด้วย STABLE_READS เท่าเดิม
    if (present && !currentState && !lightHintSent) {
      lightHintSent = true;
      abortReads    = 0;
      sendCameraLight(true);
    }

    // จุดไฟไปแล้วแต่มือหายก่อนครบ STABLE_READS → detected ไม่เคยเกิด แปลว่าเว็บ
    // ไม่เคยเริ่มขั้นตอนถ่าย จึงไม่มีใครไปถึงหน้าผลลัพธ์เพื่อสั่งดับไฟให้
    // (relayAllOff อยู่ที่นั่นที่เดียว) — คนจุดต้องดับเอง
    if (lightHintSent && !currentState) {
      if (present) {
        abortReads = 0;
      } else if (++abortReads >= STABLE_READS) {
        lightHintSent = false;
        abortReads    = 0;
        sendCameraLight(false);
      }
    }

    if (present == currentState) {
      sameReads = 0;
    } else if (++sameReads >= STABLE_READS) {
      currentState = present;
      sameReads = 0;
      if (!currentState) lightHintSent = false;   // ว่างแล้ว → พร้อมยิงไฟรอบถัดไป
      sendEvent(currentState ? "detected" : "cleared");
    }
  }

  // weight poll (ช้ากว่า)
  if (now - lastWeightRead >= WEIGHT_READ_INTERVAL) {
    lastWeightRead = now;
    currentWeight = readWeight();
  }

  // ส่งน้ำหนักเป็นระยะขณะมีของวาง
  if (currentState && now - lastWeightSend >= WEIGHT_BROADCAST_MS) {
    lastWeightSend = now;
    sendEvent("weight");
  }
}
