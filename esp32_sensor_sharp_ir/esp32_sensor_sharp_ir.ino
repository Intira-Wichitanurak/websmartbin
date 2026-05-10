/*
  Capybara Waste Sorter — ESP32 sensor bridge (Sharp IR + HX711 load cell)

  อ่าน 2 เซนเซอร์:
    1) Sharp IR distance (เช่น GP2Y0A21YK0F) — บอกว่ามีของวางหรือเปล่า
    2) HX711 + Load cell 1kg — วัดน้ำหนัก (ใช้เช็ค "เศษอาหาร")

  ส่งข้อมูลผ่าน UART2 (ไป Raspberry Pi) เป็น JSON บรรทัดละ event:
    {"event":"detected","grams": 123.4}   // IR เห็นของ + น้ำหนักล่าสุด
    {"event":"cleared","grams": 0.5}      // IR ไม่เห็นของแล้ว
    {"event":"weight","grams": 123.4}     // ส่งซ้ำทุก 500ms ระหว่างที่มีของ

  ฝั่ง Pi: scripts/serial-bridge.js อ่าน /dev/serial0 แล้วเปิด WebSocket
  server ที่ port 81 ให้เว็บ React (src/lib/sensor.js) รับไปใช้

  การต่อสาย — เซนเซอร์:
    Sharp IR Vcc  → ESP32 5V (VIN)
    Sharp IR GND  → ESP32 GND
    Sharp IR OUT  → ESP32 GPIO34
    HX711 VCC     → ESP32 VIN (5V)  หรือ 3V3 ก็ได้
    HX711 GND     → ESP32 GND
    HX711 DT/DOUT → ESP32 GPIO21
    HX711 SCK     → ESP32 GPIO22
    Load cell 4 สาย → HX711 (E+/E-/A+/A-)

  การต่อสาย — UART ระหว่าง ESP32 ↔ Raspberry Pi (3.3V ทั้งคู่ ต่อตรงได้):
    ESP32 GPIO17 (TX2) → Pi GPIO15 / RXD  (physical pin 10)
    ESP32 GPIO16 (RX2) → Pi GPIO14 / TXD  (physical pin 8)
    ESP32 GND          → Pi GND          (physical pin 6)

  Library ที่ต้องติดตั้ง (Library Manager):
    - HX711 by Bogdan Necula

  Calibration (ใช้ค่าที่คุณ tune มาแล้ว):
    CALIBRATION_FACTOR = 1157.13
    BASELINE           = 179
    สูตร: weight_g = (raw_value - BASELINE) / CALIBRATION_FACTOR
*/

#include <HX711.h>

// UART2 สำหรับส่งข้อมูลให้ Pi (Serial0/USB ยังคงไว้สำหรับ debug)
HardwareSerial PiSerial(2);
const int PI_TX_PIN = 17;   // ESP32 TX2 → Pi RX (GPIO15, pin 10)
const int PI_RX_PIN = 16;   // ESP32 RX2 ← Pi TX (GPIO14, pin 8)  ไม่ได้ใช้ส่งกลับ แต่ต่อไว้กันเหนียว

// --- Sharp IR ---
const int IR_PIN        = 34;     // ADC1_CH6 (input only)
const int ADC_THRESHOLD = 1900;   // empty ~1530, present ~2250
const int SAMPLE_COUNT  = 8;
const int STABLE_READS  = 5;

// --- HX711 load cell ---
const int   HX711_DT           = 21;
const int   HX711_SCK          = 22;
const float CALIBRATION_FACTOR = 1157.13;   // ค่าที่ calibrate มาแล้ว
const long  BASELINE           = 179;       // offset หลัง tare

HX711 scale;

// --- timing ---
const unsigned long IR_READ_INTERVAL     = 100;   // ms — IR เร็ว ตอบสนองไว
const unsigned long WEIGHT_READ_INTERVAL = 300;   // ms — HX711 ช้ากว่า, อ่านรอบยาวกว่า
const unsigned long WEIGHT_BROADCAST_MS  = 500;   // ms — ส่ง weight event ระหว่างที่มีของ

bool   currentState   = false;
int    sameReads      = 0;
float  currentWeight  = 0.0;
unsigned long lastIRRead     = 0;
unsigned long lastWeightRead = 0;
unsigned long lastWeightSend = 0;

int readIRSmoothed() {
  long sum = 0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    sum += analogRead(IR_PIN);
    delayMicroseconds(200);
  }
  return sum / SAMPLE_COUNT;
}

float readWeight() {
  if (!scale.is_ready()) return currentWeight;   // HX711 busy → ใช้ค่าเก่า
  long raw = scale.get_value(3);                  // เฉลี่ย 3 raw readings (ลด noise)
  float g = (raw - BASELINE) / CALIBRATION_FACTOR;
  if (g < 0 && g > -2) g = 0;                    // กรอง noise ติดลบเล็กๆ ใกล้ศูนย์
  return g;
}

void sendEvent(const char* event) {
  char msg[80];
  snprintf(msg, sizeof(msg), "{\"event\":\"%s\",\"grams\":%.1f}", event, currentWeight);
  Serial.print("-> "); Serial.println(msg);   // debug ผ่าน USB
  PiSerial.println(msg);                       // ส่งจริงไป Pi ผ่าน UART2
}

void sendWeight() {
  char msg[64];
  snprintf(msg, sizeof(msg), "{\"event\":\"weight\",\"grams\":%.1f}", currentWeight);
  PiSerial.println(msg);
}

void setup() {
  Serial.begin(115200);                                              // USB debug
  PiSerial.begin(115200, SERIAL_8N1, PI_RX_PIN, PI_TX_PIN);          // UART2 → Pi

  // IR
  analogReadResolution(12);
  analogSetPinAttenuation(IR_PIN, ADC_11db);

  // HX711 — ใช้สูตร calibration ที่คุณ tune มาแล้ว: g = (raw - BASELINE) / CALIBRATION_FACTOR
  scale.begin(HX711_DT, HX711_SCK);
  Serial.println("HX711: taring (ตาชั่งต้องว่างตอนนี้)...");
  delay(2000);
  scale.tare();
  Serial.println("HX711: ready");
  Serial.println("UART2 ready — ส่ง JSON event ไป Pi ที่ 115200 baud");
}

void loop() {
  unsigned long now = millis();

  // IR poll (เร็ว — ตอบสนองทันทีที่วาง/หยิบ)
  if (now - lastIRRead >= IR_READ_INTERVAL) {
    lastIRRead = now;
    int raw = readIRSmoothed();
    bool present = raw > ADC_THRESHOLD;

    Serial.printf("adc=%4d  g=%7.1f  state=%s\n",
                  raw, currentWeight, present ? "present" : "empty");

    if (present == currentState) {
      sameReads = 0;
    } else {
      sameReads++;
      if (sameReads >= STABLE_READS) {
        currentState = present;
        sameReads = 0;
        sendEvent(currentState ? "detected" : "cleared");
      }
    }
  }

  // Weight poll (ช้ากว่า — HX711 sample rate 10Hz, get_value(3) กิน ~300ms)
  if (now - lastWeightRead >= WEIGHT_READ_INTERVAL) {
    lastWeightRead = now;
    currentWeight = readWeight();
  }

  // ส่งน้ำหนักให้ Pi เป็นระยะ ขณะที่มีของวาง — เพื่อให้ตอน classify เสร็จมีค่า fresh
  if (currentState && now - lastWeightSend >= WEIGHT_BROADCAST_MS) {
    lastWeightSend = now;
    sendWeight();
  }
}
