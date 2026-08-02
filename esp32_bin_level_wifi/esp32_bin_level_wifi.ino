/*
  Capybara Waste Sorter — ESP32 #2: bin-level sensor (WiFi WebSocket)

  ESP32 ตัวที่สอง คอยเฝ้าระดับความเต็มของถังขยะแต่ละใบ (ถังละ 1 เซนเซอร์วัดระยะ)
  เมื่อขยะสูงจนใกล้ปากถัง = "เต็ม" ใส่เพิ่มไม่ได้ → แจ้งเว็บผ่าน WiFi

  ต่างจาก ESP32 ตัวแรก (esp32_sensor_sharp_ir) ที่เฝ้าจุดวางขยะแล้วส่งผ่าน UART
  ตัวนี้เข้า WiFi วง เดียวกับเว็บ แล้วเปิด WebSocket server เอง (port 81) ให้เว็บ
  React (src/lib/binStatus.js) เชื่อมตรง — ตั้ง VITE_BIN_WS_URL=ws://<ip>:81/

  ส่ง JSON บรรทัดละ message:
    ตอน client เพิ่งต่อ / เป็นระยะ  -> {"event":"bin_status","bins":{"wet":false,"recyclable":true,"hazardous":false,"general":false}}
    ตอนถังใดถังหนึ่งเปลี่ยนเป็นเต็ม -> {"event":"full","bin":"recyclable"}
    ตอนถังนั้นมีที่ว่างอีกครั้ง    -> {"event":"ok","bin":"recyclable"}

  ชื่อถังต้องตรงกับ WASTE_TYPES / relay: wet | recyclable | hazardous | general

  การต่อสาย — Sharp IR distance ถังละ 1 ตัว (ชี้ขวางปากถังลงมา):
    ถัง wet         OUT -> GPIO32 (ADC1_CH4)
    ถัง recyclable  OUT -> GPIO33 (ADC1_CH5)
    ถัง hazardous   OUT -> GPIO34 (ADC1_CH6, input only)
    ถัง general     OUT -> GPIO35 (ADC1_CH7, input only)
    Vcc -> 5V (VIN), GND -> GND ทุกตัว
  หมายเหตุ: ใช้เฉพาะขา ADC1 เพราะ ADC2 ใช้ไม่ได้ตอนเปิด WiFi

  Library ที่ต้องติดตั้ง (Library Manager):
    - WebSockets by Markus Sattler  (arduinoWebSockets)

  ค่า threshold: ยิ่งขยะสูง ระยะยิ่งใกล้ ค่า ADC ยิ่งสูง (Sharp IR: ใกล้=ค่ามาก)
  ปรับ FULL_ADC / CLEAR_ADC ให้เข้ากับความสูงถังจริง (มี hysteresis กันเด้ง)
*/

#include <WiFi.h>
#include <WebSocketsServer.h>

// ----- WiFi (แก้ให้ตรงกับวงที่เว็บ/Pi ใช้) -----
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

WebSocketsServer wsServer(81);

// ----- ถัง 4 ใบ: ชื่อ (ตรงกับฝั่งเว็บ) + ขา ADC -----
const int   NUM_BINS = 4;
const char* BIN_NAME[NUM_BINS] = { "wet", "recyclable", "hazardous", "general" };
const int   BIN_PIN[NUM_BINS]  = { 32,    33,           34,          35 };

// ----- เกณฑ์ "เต็ม" (มี hysteresis) — Sharp IR: ใกล้ = ค่า ADC สูง -----
const int FULL_ADC   = 2200;   // >= นี้ติดต่อกัน = เริ่มถือว่าเต็ม
const int CLEAR_ADC  = 1800;   // <= นี้ติดต่อกัน = กลับมามีที่ว่าง
const int STABLE_READS = 5;    // ต้องนิ่งกี่รอบก่อนยอมเปลี่ยนสถานะ (กัน noise)
const int SAMPLE_COUNT = 8;    // เฉลี่ยกี่ครั้งต่อการอ่าน 1 รอบ

// ----- timing -----
const unsigned long READ_INTERVAL     = 150;    // ms — อ่านเซนเซอร์
const unsigned long SNAPSHOT_INTERVAL = 5000;   // ms — ส่ง bin_status ซ้ำเป็นระยะ

bool binFull[NUM_BINS] = { false, false, false, false };
int  sameReads[NUM_BINS] = { 0, 0, 0, 0 };
unsigned long lastRead = 0;
unsigned long lastSnapshot = 0;

int readSmoothed(int pin) {
  long sum = 0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    sum += analogRead(pin);
    delayMicroseconds(200);
  }
  return sum / SAMPLE_COUNT;
}

void sendEvent(const char* event, const char* bin) {
  char msg[64];
  snprintf(msg, sizeof(msg), "{\"event\":\"%s\",\"bin\":\"%s\"}", event, bin);
  Serial.println(msg);
  wsServer.broadcastTXT(msg);
}

// ส่ง snapshot ทั้ง 4 ถัง (ให้ client ที่เพิ่งต่อได้สถานะครบทันที)
void sendSnapshot(int onlyClient = -1) {
  char msg[160];
  int n = snprintf(msg, sizeof(msg), "{\"event\":\"bin_status\",\"bins\":{");
  for (int i = 0; i < NUM_BINS; i++) {
    n += snprintf(msg + n, sizeof(msg) - n, "%s\"%s\":%s",
                  i ? "," : "", BIN_NAME[i], binFull[i] ? "true" : "false");
  }
  snprintf(msg + n, sizeof(msg) - n, "}}");
  if (onlyClient >= 0) wsServer.sendTXT(onlyClient, msg);
  else                 wsServer.broadcastTXT(msg);
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED) {
    Serial.printf("[ws] client %u connected\n", num);
    sendSnapshot(num);            // ส่งสถานะปัจจุบันให้ทันที
  } else if (type == WStype_DISCONNECTED) {
    Serial.printf("[ws] client %u disconnected\n", num);
  }
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (int i = 0; i < NUM_BINS; i++) analogSetPinAttenuation(BIN_PIN[i], ADC_11db);

  Serial.printf("WiFi: connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nWiFi connected. IP = %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("ตั้งค่าเว็บ: VITE_BIN_WS_URL=ws://%s:81/\n", WiFi.localIP().toString().c_str());

  wsServer.begin();
  wsServer.onEvent(onWsEvent);
  Serial.println("WebSocket server listening on port 81");
}

void loop() {
  wsServer.loop();
  unsigned long now = millis();

  if (now - lastRead >= READ_INTERVAL) {
    lastRead = now;
    for (int i = 0; i < NUM_BINS; i++) {
      int raw = readSmoothed(BIN_PIN[i]);
      // เข้าเงื่อนไขเปลี่ยนสถานะไหม? (ใช้ hysteresis: เต็มเมื่อ >=FULL, ว่างเมื่อ <=CLEAR)
      bool wantFull = binFull[i] ? (raw > CLEAR_ADC) : (raw >= FULL_ADC);

      if (wantFull == binFull[i]) {
        sameReads[i] = 0;
      } else {
        sameReads[i]++;
        if (sameReads[i] >= STABLE_READS) {
          binFull[i] = wantFull;
          sameReads[i] = 0;
          sendEvent(binFull[i] ? "full" : "ok", BIN_NAME[i]);
        }
      }
    }
  }

  // ส่ง snapshot ซ้ำเป็นระยะ กัน client ที่ reconnect พลาด event
  if (now - lastSnapshot >= SNAPSHOT_INTERVAL) {
    lastSnapshot = now;
    sendSnapshot();
  }
}
