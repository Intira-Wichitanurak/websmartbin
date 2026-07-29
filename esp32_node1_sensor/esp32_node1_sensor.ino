/*
  Capybara Waste Sorter — ESP32 NODE #1: presence + weight  (WiFi / WebSocket)

  หน้าที่:
    - HC-SR04 ultrasonic  → โบกมือผ่านเพื่อปลุกกล้อง (cm < PRESENT_CM = มีมือ, แทน Sharp IR เดิม)
    - HX711 + Load cell   → วัดน้ำหนัก (เช็ค "เศษอาหาร")
    - เชื่อม WiFi ของ Pi (AP) แล้วส่ง JSON event ไป WebSocket hub บน Pi

  ส่ง (node="sensor"):
    {"node":"sensor","event":"detected","grams":123.4}   // เห็นของ + น้ำหนักล่าสุด
    {"node":"sensor","event":"cleared","grams":0.5}       // ไม่เห็นของแล้ว
    {"node":"sensor","event":"weight","grams":123.4}      // ส่งซ้ำทุก 500ms ระหว่างมีของ

  Library ที่ต้องติดตั้ง (Library Manager):
    - HX711 by Bogdan Necula
    - WebSockets by Markus Sattler  (arduinoWebSockets / Links2004)
    - ArduinoJson by Benoit Blanchon

  การต่อสาย:
    HC-SR04 VCC   → 5V (VIN)          HX711 VCC  → 5V (VIN) หรือ 3V3
    HC-SR04 GND   → GND               HX711 GND  → GND
    HC-SR04 TRIG  → GPIO5             HX711 DT   → GPIO21
    HC-SR04 ECHO  → GPIO18 *ผ่านตัวแบ่งแรงดัน 5V→3.3V (เช่น R 1k + 2k)   HX711 SCK → GPIO22
    Load cell 4 สาย → HX711 (E+/E-/A+/A-)

  Calibration (ค่าเดิมที่ tune ไว้):
    CALIBRATION_FACTOR = 1157.13 ; BASELINE = 179
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

// ---------- HC-SR04 (presence) ----------
const int TRIG_PIN = 5;
const int ECHO_PIN = 18;
const float PRESENT_CM   = 45.0;   // ต่ำกว่านี้ = มีมือผ่าน → ยิง detected ปลุกกล้อง
const int   STABLE_READS = 5;

// ---------- HX711 load cell ----------
const int   HX711_DT           = 21;
const int   HX711_SCK          = 22;
const float CALIBRATION_FACTOR = 1157.13;
const long  BASELINE           = 179;
HX711 scale;

// ---------- timing ----------
const unsigned long IR_READ_INTERVAL     = 100;
const unsigned long WEIGHT_READ_INTERVAL = 300;
const unsigned long WEIGHT_BROADCAST_MS  = 500;

bool  currentState  = false;
int   sameReads     = 0;
float currentWeight = 0.0;
unsigned long lastRead = 0, lastWeightRead = 0, lastWeightSend = 0, lastDbg = 0;

// ---------- ultrasonic read → cm ----------
float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 30000);   // timeout 30ms (~5m)
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

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)      { wsConnected = true;  Serial.println("[ws] connected"); }
  else if (type == WStype_DISCONNECTED) { wsConnected = false; Serial.println("[ws] disconnected"); }
}

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  scale.begin(HX711_DT, HX711_SCK);
  Serial.println("HX711: taring (ตาชั่งต้องว่างและนิ่ง)...");
  delay(2000);
  scale.tare();                   // zero ตอนบูต — ตาชั่งต้องว่าง
  Serial.println("HX711: ready");

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

  // presence poll (เร็ว)
  if (now - lastRead >= IR_READ_INTERVAL) {
    lastRead = now;
    float cm = readDistanceCm();
    bool present = cm <= PRESENT_CM;

    // debug: พิมพ์ระยะจริง + น้ำหนัก ทุก 500ms (ดูว่าทำไม SR04 เด้งตลอด)
    if (now - lastDbg >= 500) {
      lastDbg = now;
      Serial.printf("[sr04] cm=%.1f  w=%.1f g  %s\n",
                    cm, currentWeight, present ? "PRESENT" : "empty");
    }

    if (present == currentState) {
      sameReads = 0;
    } else if (++sameReads >= STABLE_READS) {
      currentState = present;
      sameReads = 0;
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
