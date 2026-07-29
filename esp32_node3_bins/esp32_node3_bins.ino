/*
  Capybara Waste Sorter — ESP32 NODE #3: bin levels + status LEDs  (WiFi / WebSocket)

  หน้าที่:
    - HC-SR04 x4  → วัดระดับขยะในถัง 4 ใบ (ระยะจากปากถังถึงผิวขยะ → % เต็ม)
    - RGB LED x4  → ไฟสถานะแต่ละถัง (เขียว=ว่าง, เหลือง=ครึ่ง, แดง=เต็ม)

  ส่ง (node="bins") ทุก BROADCAST_MS:
    {"node":"bins","event":"levels","bins":[
        {"i":0,"cm":18.2,"pct":40,"color":"green"}, ... ]}

  รับ override สี LED ได้ (node="leds") — สี = "red"/"yellow"/"green":
    {"node":"leds","event":"set","leds":[{"i":0,"color":"red"}, ...]}
    {"node":"leds","event":"auto"}    // กลับไปให้ไฟตามระดับถังอัตโนมัติ

  Library: WebSockets (Links2004) + ArduinoJson

  การต่อสาย — HC-SR04 (ต่อ ECHO ผ่านตัวแบ่งแรงดัน 5V→3.3V ทุกตัว):
    bin0 TRIG=GPIO5  ECHO=GPIO18     bin1 TRIG=GPIO17 ECHO=GPIO16
    bin2 TRIG=GPIO4  ECHO=GPIO2      bin3 TRIG=GPIO15 ECHO=GPIO19

  การต่อสาย — LED 3 สีแยกดวง (แดง/เหลือง/เขียว, active-HIGH = ต่อ common-cathode):
    mod1 R=GPIO23 Y=GPIO22 G=GPIO21     mod2 R=GPIO13 Y=GPIO12 G=GPIO14
    mod3 R=GPIO27 Y=GPIO26 G=GPIO25     mod4 R=GPIO33 Y=GPIO3  G=GPIO32
    ถ้าไฟกลับด้าน (ติดตอนควรดับ) ให้ตั้ง LED_ACTIVE_HIGH = false
    * GPIO3 = RX0: ถ้า upload ไม่ผ่าน ให้ถอดขา Y ของ mod4 ตอนอัปโหลด
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#define WIFI_SSID  "CapybaraBin"
#define WIFI_PASS  "capybara1234"
#define HUB_HOST   "192.168.50.1"
#define HUB_PORT   8181
#define HUB_PATH   "/"

const int  N_BIN = 4;
const bool LED_ACTIVE_HIGH = true;   // common-cathode: HIGH = ติด (ถ้ากลับด้านให้ false)

// ระดับถัง: ปากถังถึงก้น (cm). ยิ่งระยะที่วัดได้น้อย = ขยะยิ่งสูง = ยิ่งเต็ม
const float BIN_DEPTH_CM = 50.0;   // ความลึกถัง (ปรับตามถังจริง)
const float FULL_CM      = 5.0;    // ระยะเหลือ <= ค่านี้ = ถือว่าเต็ม 100%

const int TRIG_PINS[N_BIN] = { 5,  17, 4,  15 };
const int ECHO_PINS[N_BIN] = { 18, 16, 2,  19 };

// LED 3 สีแยกดวง — [bin][0=R,1=Y,2=G]  (แดง/เหลือง/เขียว)
const int LED_PINS[N_BIN][3] = {
  { 23, 22, 21 },   // mod1
  { 13, 12, 14 },   // mod2
  { 27, 26, 25 },   // mod3
  { 33, 3,  32 },   // mod4
};

const unsigned long READ_MS      = 500;    // อ่านถังทุก 0.5s
const unsigned long BROADCAST_MS = 1000;   // ส่งสถานะทุก 1s

WebSocketsClient ws;
unsigned long lastRead = 0, lastBroadcast = 0;
float binCm[N_BIN]   = { 999, 999, 999, 999 };
int   binPct[N_BIN]  = { 0, 0, 0, 0 };
bool  ledAuto        = true;      // true = ไฟตามระดับถัง, false = ถูก override

float readDistanceCm(int i) {
  digitalWrite(TRIG_PINS[i], LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PINS[i], HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PINS[i], LOW);
  long us = pulseIn(ECHO_PINS[i], HIGH, 30000);
  if (us == 0) return 999.0;
  return us / 58.0;
}

int pctFromCm(float cm) {
  if (cm >= 999) return 0;
  float filled = BIN_DEPTH_CM - cm;                 // ความสูงขยะ
  float span   = BIN_DEPTH_CM - FULL_CM;
  int pct = (int)((filled / span) * 100.0 + 0.5);
  if (pct < 0) pct = 0; if (pct > 100) pct = 100;
  return pct;
}

const char* colorFor(int pct) {
  if (pct >= 80) return "red";
  if (pct >= 50) return "yellow";
  return "green";
}

// เปิด/ปิดแต่ละสี (r,y,g = 1 ติด / 0 ดับ) — LED 3 ดวงแยกขา
void ledSet(int i, bool r, bool y, bool g) {
  int on  = LED_ACTIVE_HIGH ? HIGH : LOW;
  int off = LED_ACTIVE_HIGH ? LOW  : HIGH;
  digitalWrite(LED_PINS[i][0], r ? on : off);
  digitalWrite(LED_PINS[i][1], y ? on : off);
  digitalWrite(LED_PINS[i][2], g ? on : off);
}

void ledForColor(int i, const char* c) {
  if      (!strcmp(c, "red"))    ledSet(i, 1, 0, 0);
  else if (!strcmp(c, "yellow")) ledSet(i, 0, 1, 0);
  else                           ledSet(i, 0, 0, 1);   // green
}

void applyAutoLeds() {
  for (int i = 0; i < N_BIN; i++) ledForColor(i, colorFor(binPct[i]));
}

void broadcastLevels() {
  StaticJsonDocument<512> doc;
  doc["node"]  = "bins";
  doc["event"] = "levels";
  JsonArray arr = doc.createNestedArray("bins");
  for (int i = 0; i < N_BIN; i++) {
    JsonObject o = arr.createNestedObject();
    o["i"]     = i;
    o["cm"]    = round(binCm[i] * 10) / 10.0;
    o["pct"]   = binPct[i];
    o["color"] = colorFor(binPct[i]);
  }
  char buf[512];
  size_t n = serializeJson(doc, buf);
  ws.sendTXT(buf, n);
}

void handleMessage(uint8_t* payload, size_t len) {
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, payload, len)) return;
  if (strcmp(doc["node"] | "", "leds") != 0) return;

  const char* event = doc["event"] | "";
  if (!strcmp(event, "auto")) {
    ledAuto = true;
    applyAutoLeds();
  } else if (!strcmp(event, "set")) {
    ledAuto = false;
    for (JsonObject o : doc["leds"].as<JsonArray>()) {
      int i = o["i"] | -1;
      const char* c = o["color"] | "green";   // "red" / "yellow" / "green"
      if (i >= 0 && i < N_BIN) ledForColor(i, c);
    }
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)         Serial.println("[ws] connected");
  else if (type == WStype_DISCONNECTED) Serial.println("[ws] disconnected");
  else if (type == WStype_TEXT)         handleMessage(payload, len);
}

void setup() {
  Serial.begin(115200);

  for (int i = 0; i < N_BIN; i++) {
    pinMode(TRIG_PINS[i], OUTPUT);
    pinMode(ECHO_PINS[i], INPUT);
    for (int c = 0; c < 3; c++) pinMode(LED_PINS[i][c], OUTPUT);
    ledForColor(i, "green");
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
  unsigned long now = millis();

  if (now - lastRead >= READ_MS) {
    lastRead = now;
    for (int i = 0; i < N_BIN; i++) {
      binCm[i]  = readDistanceCm(i);
      binPct[i] = pctFromCm(binCm[i]);
    }
    if (ledAuto) applyAutoLeds();

    // debug: ระยะ/เปอร์เซ็นต์/สี ของถังทั้ง 4 ทุกครั้งที่อ่าน
    Serial.printf("[bins] 0:%.0fcm/%d%%/%s  1:%.0fcm/%d%%/%s  2:%.0fcm/%d%%/%s  3:%.0fcm/%d%%/%s\n",
      binCm[0], binPct[0], colorFor(binPct[0]),
      binCm[1], binPct[1], colorFor(binPct[1]),
      binCm[2], binPct[2], colorFor(binPct[2]),
      binCm[3], binPct[3], colorFor(binPct[3]));
  }

  if (now - lastBroadcast >= BROADCAST_MS) {
    lastBroadcast = now;
    broadcastLevels();
  }
}
