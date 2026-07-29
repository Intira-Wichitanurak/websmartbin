#!/usr/bin/env bash
#
# setup-ap.sh — ตั้ง Raspberry Pi (Bookworm / Pi 5) ให้เป็น WiFi Access Point
# ที่ ESP32 ทั้ง 3 ตัวมาเกาะ แล้วคุยกับ WebSocket hub (scripts/ws-hub.js) บน Pi
#
# ใช้ NetworkManager (nmcli) ซึ่งเป็นค่าเริ่มต้นของ Pi OS Bookworm — ไม่ต้อง
# ตั้ง hostapd/dnsmasq เอง Pi จะทำ DHCP ให้ ESP32 อัตโนมัติ
#
# หลังรัน:
#   - SSID/รหัสผ่าน = ค่าด้านล่าง (แก้ได้)
#   - Pi ได้ IP คงที่ 192.168.50.1 บน interface wlan0
#   - ESP32 ตั้ง HUB_HOST = 192.168.50.1, HUB_PORT = 8181
#
# รัน: sudo bash scripts/setup-ap.sh
# ปิด AP กลับเป็น WiFi ปกติ: sudo nmcli connection down capybara-ap
#
set -euo pipefail

SSID="${AP_SSID:-CapybaraBin}"
PASS="${AP_PASS:-capybara1234}"      # อย่างน้อย 8 ตัวอักษร
CON_NAME="capybara-ap"
IFACE="${AP_IFACE:-wlan0}"
AP_IP="${AP_IP:-192.168.50.1/24}"

if [[ $EUID -ne 0 ]]; then
  echo "ต้องรันด้วย sudo: sudo bash scripts/setup-ap.sh" >&2
  exit 1
fi

echo "[ap] สร้าง/อัปเดต hotspot '$SSID' บน $IFACE (IP $AP_IP)"

# ลบ connection เดิมชื่อเดียวกันถ้ามี (idempotent)
nmcli connection delete "$CON_NAME" >/dev/null 2>&1 || true

nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$CON_NAME" \
  autoconnect yes \
  ssid "$SSID"

nmcli connection modify "$CON_NAME" \
  802-11-wireless.mode ap \
  802-11-wireless.band bg \
  ipv4.method shared \
  ipv4.addresses "$AP_IP" \
  wifi-sec.key-mgmt wpa-psk \
  wifi-sec.psk "$PASS"

nmcli connection up "$CON_NAME"

echo "[ap] เรียบร้อย — SSID='$SSID'  PASS='$PASS'  Pi IP=${AP_IP%/*}"
echo "[ap] ให้ ESP32 ตั้ง HUB_HOST=${AP_IP%/*}  HUB_PORT=8181"
echo "[ap] ปิด AP: sudo nmcli connection down $CON_NAME"
