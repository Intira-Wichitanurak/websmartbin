/*
  Capybara Waste Sorter — ESP32 NODE #2: relay control  (WiFi / WebSocket)

  หน้าที่: คุมรีเลย์ 4 ตัว = ไฟบอกประเภทขยะ
    wet / recyclable / hazardous / general
  (ไฟกล้องย้ายไปให้ Pi คุมผ่าน GPIO เอง — ไม่เกี่ยวกับ node นี้แล้ว)

  รับคำสั่งจาก hub (node="relay"):
    {"node":"relay","event":"classify","type":"wet"}   // เปิดตัวที่ตรง ปิดที่เหลือ, auto-off 20s
    {"node":"relay","event":"all_off"}                  // ปิดทุกตัว

  รีเลย์โมดูลถูกๆ ส่วนใหญ่เป็น active-LOW (LOW = ติด) — ตั้ง RELAY_ACTIVE_LOW ตามโมดูล

  Library: WebSockets (Links2004) + ArduinoJson

  การต่อสาย (relay IN → ESP32 GPIO):
    wet=GPIO25  recyclable=GPIO26  hazardous=GPIO27  general=GPIO14
    รีเลย์ VCC → 5V, GND → GND ร่วมกับ ESP32
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#define WIFI_SSID  "CapybaraBin"
#define WIFI_PASS  "capybara1234"
#define HUB_HOST   "192.168.50.1"
#define HUB_PORT   8181
#define HUB_PATH   "/"

const bool RELAY_ACTIVE_LOW = true;
const unsigned long CLASSIFY_ON_MS = 20000;   // ไฟประเภทขยะติดค้าง 20s แล้วดับเอง

// ลำดับ: wet, recyclable, hazardous, general
const char* RELAY_NAMES[] = { "wet", "recyclable", "hazardous", "general" };
const int   RELAY_PINS[]  = {  25,    26,           27,          14 };
const int   N_RELAY = 4;

WebSocketsClient ws;
unsigned long classifyOffAt = 0;   // 0 = ไม่มีนัดปิด
int           classifyIdx   = -1;

void relayWrite(int idx, bool on) {
  int level = (RELAY_ACTIVE_LOW ? !on : on);
  digitalWrite(RELAY_PINS[idx], level);
}

void allOff() {
  for (int i = 0; i < N_RELAY; i++) relayWrite(i, false);
  classifyOffAt = 0; classifyIdx = -1;
}

int idxOf(const char* name) {
  for (int i = 0; i < N_RELAY; i++)
    if (strcmp(RELAY_NAMES[i], name) == 0) return i;
  return -1;
}

void handleMessage(uint8_t* payload, size_t len) {
  StaticJsonDocument<160> doc;
  if (deserializeJson(doc, payload, len)) return;
  if (strcmp(doc["node"] | "", "relay") != 0) return;   // ไม่ใช่คำสั่งของเรา

  const char* event = doc["event"] | "";

  if (!strcmp(event, "classify")) {
    const char* type = doc["type"] | "";
    allOff();
    int i = idxOf(type);
    if (i >= 0) {
      relayWrite(i, true);
      classifyIdx = i;
      classifyOffAt = millis() + CLASSIFY_ON_MS;
      Serial.printf("[relay] classify -> %s ON\n", type);
    }
  } else if (!strcmp(event, "all_off")) {
    allOff();
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)         Serial.println("[ws] connected");
  else if (type == WStype_DISCONNECTED) Serial.println("[ws] disconnected");
  else if (type == WStype_TEXT)         handleMessage(payload, len);
}

void setup() {
  Serial.begin(115200);

  for (int i = 0; i < N_RELAY; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    relayWrite(i, false);   // เริ่มต้นปิดทุกตัว
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);  // ยอมรับ WPA-PSK — แก้ค้าง status=6 กับ NM AP
  WiFi.disconnect(true, true);
  delay(200);
  Serial.printf("[wifi] joining '%s' ...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.printf("[wifi] status=%d rssi=%d\n", WiFi.status(), WiFi.RSSI());
    if (millis() - t0 > 12000) {
      WiFi.disconnect(true, true); delay(200);
      WiFi.begin(WIFI_SSID, WIFI_PASS); t0 = millis();
    }
  }
  Serial.printf("[wifi] connected, IP=%s\n", WiFi.localIP().toString().c_str());

  ws.begin(HUB_HOST, HUB_PORT, HUB_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
}

void loop() {
  ws.loop();

  // ปิดไฟประเภทขยะเมื่อครบเวลา
  if (classifyOffAt && millis() >= classifyOffAt) {
    Serial.printf("[relay] classify -> %s OFF\n", RELAY_NAMES[classifyIdx]);
    relayWrite(classifyIdx, false);
    classifyOffAt = 0; classifyIdx = -1;
  }
}
