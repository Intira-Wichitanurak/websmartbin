"""
Capybara Waste Sorter — PyTorch inference server

โหลด best_waste_classifier_EfficientNetV2-S.pth (EfficientNetV2-S fine‑tuned, 6 คลาส)
แล้วเปิด HTTP endpoint ให้เว็บแอป (src/lib/classifyWaste.js) ส่งภาพมาแยกประเภท

หมายเหตุ: การคุมรีเลย์/ไฟกล้อง ย้ายไปอยู่ที่ ESP32 NODE #2 (คุยผ่าน WebSocket hub)
แล้ว — เซิร์ฟเวอร์นี้ทำแค่ AI classification อย่างเดียว ไม่ยุ่ง GPIO อีกต่อไป

โมเดลคลาส (จาก class_map.json): Bottle, Cans, Danger, Foodpekage, Freshfood, General
แมปเป็นชนิดขยะของแอป (WASTE_TYPES ใน classifyWaste.js):
    Bottle     -> recyclable
    Cans       -> recyclable
    Danger     -> hazardous
    Freshfood  -> wet
    Foodpekage -> general
    General    -> general

รองรับ checkpoint ได้ 2 รูปแบบ:
  1. Wrapped: {'model': state_dict, 'classes': [...], 'val_acc': ...}
  2. Raw state dict (features.* / classifier.*) พร้อม auto remap classifier key

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

import torch
import torchvision.models as M
import torchvision.transforms as T
from PIL import Image
from flask import Flask, request, jsonify

HERE        = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH  = os.path.join(HERE, 'public', 'best_waste_classifier_EfficientNetV2-S.pth')
CLASSMAP    = os.path.join(HERE, 'public', 'class_map.json')
HOST        = os.environ.get('MODEL_HOST', '0.0.0.0')
PORT        = int(os.environ.get('MODEL_PORT', '8000'))

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


# ---------------- camera light (Pi GPIO via lgpio) ----------------
# ไฟกล้อง 1 ดวง คุมด้วย Pi โดยตรง (ไฟบอกประเภทขยะ 4 ดวงย้ายไปอยู่ที่ ESP32 #2)
# ถ้า import lgpio ไม่ได้ (รันบนเครื่องอื่น) → degrade เป็น no-op, /camera ยังเรียกได้
try:
    import atexit
    import lgpio
    _LGPIO_OK = True
except Exception as e:
    print(f'[camera] lgpio not available ({e}) — camera light disabled')
    lgpio = None
    _LGPIO_OK = False

CAMERA_PIN        = int(os.environ.get('CAMERA_PIN', '24'))
CAMERA_ACTIVE_LOW = os.environ.get('CAMERA_ACTIVE_LOW', '1') != '0'
_cam_h = None

def _cam_level(on):
    if CAMERA_ACTIVE_LOW:
        return 0 if on else 1
    return 1 if on else 0

def camera_light(on):
    if not _LGPIO_OK or _cam_h is None:
        return
    lgpio.gpio_write(_cam_h, CAMERA_PIN, _cam_level(on))

def camera_init():
    global _cam_h
    if not _LGPIO_OK:
        return
    try:
        _cam_h = lgpio.gpiochip_open(0)
        lgpio.gpio_claim_output(_cam_h, CAMERA_PIN, _cam_level(False))
        print(f'[camera] ready (pin {CAMERA_PIN}, active-{"LOW" if CAMERA_ACTIVE_LOW else "HIGH"})')
    except Exception as e:
        print(f'[camera] init failed: {e}')
        _cam_h = None

if _LGPIO_OK:
    @atexit.register
    def _camera_cleanup():
        global _cam_h
        if _cam_h is not None:
            try:
                lgpio.gpio_write(_cam_h, CAMERA_PIN, _cam_level(False))
                lgpio.gpiochip_close(_cam_h)
            except Exception:
                pass
            _cam_h = None

camera_init()


# โมเดลคลาส (index ตาม class_map) -> ชนิดขยะของแอป
CLASS_TO_APP_TYPE = {
    'Bottle': 'recyclable',
    'Cans': 'recyclable',
    'Danger': 'hazardous',
    'Freshfood': 'wet',
    'Foodpekage': 'general',
    'General': 'general',
}


# ---------------- model loader (EfficientNetV2-S, N classes) ----------------
def load_model():
    state_dict = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    classes = None
    val_acc = None

    # support both wrapped {'model':..., 'classes':..., 'val_acc':...} and raw state dict
    if isinstance(state_dict, dict) and 'model' in state_dict:
        classes = state_dict.get('classes')
        val_acc = state_dict.get('val_acc')
        state_dict = state_dict['model']
    elif isinstance(state_dict, dict) and 'state_dict' in state_dict:
        state_dict = state_dict['state_dict']

    if classes is None:
        with open(CLASSMAP, encoding='utf-8') as f:
            classes = json.load(f)['classes']

    n_classes = len(classes)

    # auto-remap classifier keys: classifier.1.1.* → classifier.1.*
    # (some training scripts wrap classifier in an extra Sequential)
    state_dict = {
        k.replace('classifier.1.1.', 'classifier.1.'): v
        for k, v in state_dict.items()
    }

    model = M.efficientnet_v2_s(weights=None, num_classes=n_classes)
    model.load_state_dict(state_dict, strict=True)
    model.eval().to(DEVICE)

    print(f'[model] loaded {MODEL_PATH}')
    print(f'[model] classes: {classes}  device: {DEVICE}')
    if val_acc is not None:
        print(f'[model] checkpoint val_acc: {val_acc}')
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


@app.route('/camera', methods=['POST', 'OPTIONS'])
def camera():
    """เปิด/ปิดไฟกล้อง (Pi GPIO). body: {"on": true|false}"""
    if request.method == 'OPTIONS':
        return ('', 204)
    payload = request.get_json(silent=True) or {}
    on = bool(payload.get('on'))
    camera_light(on)
    print(f'[camera] light -> {"ON" if on else "OFF"}', flush=True)
    return jsonify({'ok': True, 'camera': 'on' if on else 'off'})


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'classes': CLASSES, 'device': str(DEVICE)})


if __name__ == '__main__':
    print(f'[server] listening on http://{HOST}:{PORT}  (POST /classify)')
    app.run(host=HOST, port=PORT, threaded=True)
