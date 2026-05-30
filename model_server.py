"""
Capybara Waste Sorter — PyTorch inference server

โหลด public/best_model.pt (EfficientNetV2-S + custom head, 4 คลาส) แล้วเปิด HTTP
endpoint ให้เว็บแอป (src/lib/classifyWaste.js) ส่งภาพมาแยกประเภท

โมเดลคลาส (จาก class_map.json): Bottle, Cans, General, Foodpekage
แมปเป็นชนิดขยะของแอป (WASTE_TYPES ใน classifyWaste.js):
    Bottle     -> recyclable
    Cans       -> recyclable
    General    -> general
    Foodpekage -> general

รัน:
    pip install flask torch torchvision pillow   (มีครบแล้วในเครื่องนี้)
    python model_server.py
ค่าเริ่มต้น: http://0.0.0.0:8000/classify  (POST JSON {"image": "data:image/jpeg;base64,..."})

ตั้ง host/port ผ่าน env: MODEL_HOST, MODEL_PORT
"""

import os
import io
import json
import base64
import atexit
import threading

import torch
import torch.nn as nn
import torchvision.models as M
import torchvision.transforms as T
from PIL import Image
from flask import Flask, request, jsonify

# lgpio บน Pi 5 — relay control ผ่าน GPIO. ถ้า import ไม่ได้ (รันบนเครื่องอื่น)
# จะ degrade gracefully: relay calls ทำงานเป็น no-op และเว็บก็ยังเรียก /relay ได้
try:
    import lgpio
    _LGPIO_OK = True
except Exception as e:
    print(f'[relay] lgpio not available ({e}) — relay control disabled')
    lgpio = None
    _LGPIO_OK = False

HERE        = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH  = os.path.join(HERE, 'public', 'best_model.pt')
CLASSMAP    = os.path.join(HERE, 'public', 'class_map.json')
HOST        = os.environ.get('MODEL_HOST', '0.0.0.0')
PORT        = int(os.environ.get('MODEL_PORT', '8000'))

# Relay config — 5 relays controlled by Pi GPIO.
#   1..4 = waste type indicators (wet/recyclable/hazardous/general)
#   5    = camera light (auto-off after CAMERA_IDLE_SEC of no activity)
# Most cheap 4/8-channel relay modules are active-LOW (LOW = relay ON).
# Override with env var if your module is active-HIGH: RELAY_ACTIVE_LOW=0
RELAY_PINS = {
    'wet':         17,
    'recyclable':  27,
    'hazardous':   22,
    'general':     23,
    'camera':      24,
}
RELAY_ACTIVE_LOW = os.environ.get('RELAY_ACTIVE_LOW', '1') != '0'
CAMERA_IDLE_SEC  = int(os.environ.get('CAMERA_IDLE_SEC', '300'))   # 5 นาที

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# โมเดลคลาส (index ตาม class_map) -> ชนิดขยะของแอป
CLASS_TO_APP_TYPE = {
    'Bottle':     'recyclable',
    'Cans':       'recyclable',
    'General':    'general',
    'Foodpekage': 'general',
}


# ---------------- model definition (ตรงกับตอน train) ----------------
class WasteNet(nn.Module):
    def __init__(self, n_classes=4, dropout=0.3):
        super().__init__()
        self.backbone = M.efficientnet_v2_s(weights=None)
        self.backbone.classifier = nn.Identity()   # ใช้เป็น feature extractor (1280-d)
        self.head = nn.Sequential(
            nn.Linear(1280, 512),
            nn.BatchNorm1d(512),
            nn.ReLU(inplace=True),
            nn.Dropout(dropout),
            nn.Linear(512, n_classes),
        )

    def forward(self, x):
        return self.head(self.backbone(x))


def load_model():
    ckpt = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    classes = ckpt.get('classes')
    if classes is None:
        with open(CLASSMAP, encoding='utf-8') as f:
            classes = json.load(f)['classes']
    model = WasteNet(n_classes=len(classes))
    model.load_state_dict(ckpt['model'], strict=True)
    model.eval().to(DEVICE)
    print(f'[model] loaded {MODEL_PATH}')
    print(f'[model] classes: {classes}  device: {DEVICE}')
    if 'val_acc' in ckpt:
        print(f'[model] checkpoint val_acc: {ckpt["val_acc"]}')
    return model, classes


with open(CLASSMAP, encoding='utf-8') as f:
    IMG_SIZE = json.load(f).get('image_size', 224)

# preprocessing — resize 224 + ImageNet normalize (มาตรฐาน efficientnet)
preprocess = T.Compose([
    T.Resize((IMG_SIZE, IMG_SIZE)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

MODEL, CLASSES = load_model()


# ---------------- relay control (lgpio) ----------------
_gpio_h     = None
_relay_lock = threading.RLock()   # reentrant — camera_off_now() holds it then calls relay_set()
_cam_timer  = None   # threading.Timer หรือ None — นับเวลา idle ของไฟกล้อง

def _relay_level_for(on):
    """on=True → ระดับ GPIO ที่ทำให้ relay ติด; on=False → ระดับที่ปิด"""
    if RELAY_ACTIVE_LOW:
        return 0 if on else 1
    return 1 if on else 0


def relay_set(name, on):
    """ตั้งสถานะรีเลย์ตัวที่ระบุ (name = wet/recyclable/hazardous/general/camera)"""
    if not _LGPIO_OK or _gpio_h is None:
        return
    pin = RELAY_PINS.get(name)
    if pin is None:
        return
    with _relay_lock:
        lgpio.gpio_write(_gpio_h, pin, _relay_level_for(on))


def _all_classify_off():
    for n in ('wet', 'recyclable', 'hazardous', 'general'):
        relay_set(n, False)


def _camera_off_internal():
    global _cam_timer
    _cam_timer = None
    relay_set('camera', False)
    print('[relay] camera light → OFF (idle timeout)', flush=True)


def camera_keep_alive():
    """เรียกเมื่อมีการใช้กล้อง — เปิดไฟกล้อง + รีเซ็ตเวลา idle เป็น 5 นาที"""
    global _cam_timer
    with _relay_lock:
        relay_set('camera', True)
        if _cam_timer is not None:
            _cam_timer.cancel()
        _cam_timer = threading.Timer(CAMERA_IDLE_SEC, _camera_off_internal)
        _cam_timer.daemon = True
        _cam_timer.start()


def camera_off_now():
    global _cam_timer
    with _relay_lock:
        if _cam_timer is not None:
            _cam_timer.cancel()
            _cam_timer = None
        relay_set('camera', False)


def relay_init():
    """เปิด gpiochip + ตั้งทุกขาเป็น output ค่าเริ่มต้น = OFF"""
    global _gpio_h
    if not _LGPIO_OK:
        return
    try:
        _gpio_h = lgpio.gpiochip_open(0)
        off_level = _relay_level_for(False)
        for name, pin in RELAY_PINS.items():
            lgpio.gpio_claim_output(_gpio_h, pin, off_level)
        print(f'[relay] ready (active-{"LOW" if RELAY_ACTIVE_LOW else "HIGH"}, '
              f'camera idle {CAMERA_IDLE_SEC}s) pins={RELAY_PINS}')
    except Exception as e:
        print(f'[relay] init failed: {e}')
        _gpio_h = None


@atexit.register
def relay_cleanup():
    """ปิดรีเลย์ทุกตัวตอน server หยุด"""
    global _cam_timer, _gpio_h
    if _cam_timer is not None:
        try: _cam_timer.cancel()
        except Exception: pass
        _cam_timer = None
    if _LGPIO_OK and _gpio_h is not None:
        try:
            off_level = _relay_level_for(False)
            for pin in RELAY_PINS.values():
                try: lgpio.gpio_write(_gpio_h, pin, off_level)
                except Exception: pass
            lgpio.gpiochip_close(_gpio_h)
        except Exception:
            pass
        _gpio_h = None


relay_init()


app = Flask(__name__)


@app.after_request
def add_cors(resp):
    # อนุญาตให้เบราว์เซอร์ (เว็บแอป Vite) เรียกข้าม origin ได้
    resp.headers['Access-Control-Allow-Origin']  = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp


def decode_image(data_url):
    """รับ data URL (data:image/jpeg;base64,...) หรือ base64 ล้วน -> PIL RGB"""
    if ',' in data_url and data_url.strip().startswith('data:'):
        data_url = data_url.split(',', 1)[1]
    raw = base64.b64decode(data_url)
    return Image.open(io.BytesIO(raw)).convert('RGB')


@app.route('/classify', methods=['POST', 'OPTIONS'])
def classify():
    if request.method == 'OPTIONS':
        return ('', 204)

    payload = request.get_json(silent=True) or {}
    image_b64 = payload.get('image')
    if not image_b64:
        return jsonify({'error': 'missing "image" field'}), 400

    try:
        img = decode_image(image_b64)
    except Exception as e:
        return jsonify({'error': f'bad image: {e}'}), 400

    x = preprocess(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        logits = MODEL(x)
        probs = torch.softmax(logits, dim=1)[0].cpu().tolist()

    best_idx = int(max(range(len(probs)), key=lambda i: probs[i]))
    model_class = CLASSES[best_idx]
    app_type = CLASS_TO_APP_TYPE.get(model_class, 'general')

    detail = '  '.join(f'{c}={p:.2f}' for c, p in zip(CLASSES, probs))
    print(f'[predict] {model_class} ({probs[best_idx]:.0%}) -> {app_type}   [{detail}]', flush=True)

    return jsonify({
        'type':        app_type,                 # ชนิดขยะที่แอปใช้ (recyclable/general/...)
        'modelClass':  model_class,              # คลาสดิบจากโมเดล (Bottle/Cans/...)
        'confidence':  float(probs[best_idx]),
        'probs':       probs,
        'classes':     CLASSES,
        'idx':         best_idx,
    })


@app.route('/relay', methods=['POST', 'OPTIONS'])
def relay():
    """
    ควบคุมรีเลย์จากเว็บแอป — ส่ง JSON:
       {"event": "classify",      "type": "wet"|"recyclable"|"hazardous"|"general"}
       {"event": "camera_active"}   — เปิดไฟกล้อง + รีเซ็ตเวลา idle เป็น 5 นาที
       {"event": "camera_off"}      — ปิดไฟกล้องทันที
       {"event": "all_off"}         — ปิดรีเลย์ทุกตัว
    """
    if request.method == 'OPTIONS':
        return ('', 204)

    payload = request.get_json(silent=True) or {}
    event = (payload.get('event') or '').lower()

    if event == 'classify':
        wtype = payload.get('type')
        _all_classify_off()
        if wtype in RELAY_PINS and wtype != 'camera':
            relay_set(wtype, True)
            print(f'[relay] classify → {wtype} ON', flush=True)
        return jsonify({'ok': True, 'type': wtype})

    if event == 'camera_active':
        camera_keep_alive()
        return jsonify({'ok': True, 'camera': 'on'})

    if event == 'camera_off':
        camera_off_now()
        return jsonify({'ok': True, 'camera': 'off'})

    if event == 'all_off':
        _all_classify_off()
        camera_off_now()
        return jsonify({'ok': True})

    return jsonify({'ok': False, 'error': 'unknown event'}), 400


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'classes': CLASSES, 'device': str(DEVICE)})


if __name__ == '__main__':
    print(f'[server] listening on http://{HOST}:{PORT}  (POST /classify)')
    app.run(host=HOST, port=PORT, threaded=True)
