"""
Capybara Waste Sorter — PyTorch inference server (EfficientNetV2-S + head)

โหลดโมเดลจาก MODEL_PATH (ดูด้านล่าง) — รองรับทั้ง state_dict เปล่าและ checkpoint ห่อ:
    backbone.features → avgpool → Dropout → Linear(1280,7)

โมเดล 7 คลาส (ลำดับจาก 'classes' ในไฟล์) แมปเป็นชนิดขยะของแอป:
    Battery      -> hazardous
    Bottle       -> recyclable
    Cans         -> recyclable
    Food         -> wet
    Foodpekage   -> general
    General      -> general
    Plastic Cups -> recyclable

รองรับ .pt/.pth (PyTorch หลายแบบ), .onnx และ .keras/.h5 (Keras 3) — เลือก backend จากนามสกุลไฟล์
preprocess: resize + normalize ตามที่ checkpoint ระบุ (fallback = ImageNet)
+ ความมั่นใจต่ำกว่า CONF_THRESHOLD → ตีเป็น general ไว้ก่อน (เปิดอยู่: ค่าเริ่มต้น 0.40)

รัน: python model_server.py   (ต้องมี torch/torchvision/flask/pillow)
ค่าเริ่มต้น: http://0.0.0.0:8000/classify  (POST {"image":"data:image/jpeg;base64,..."})
ตั้ง host/port/threshold ผ่าน env: MODEL_HOST, MODEL_PORT, CONF_THRESHOLD
ความสว่างกล้องตอนถ่าย: CAMERA_BRIGHTNESS (ค่าเริ่มต้น -64), CAMERA_GAMMA, CAMERA_V4L2_DEV
"""

import os
import io
import json
import base64
import threading
import subprocess

import torch
import torch.nn as nn
import torchvision.models as M
import torchvision.transforms as T
from PIL import Image
from flask import Flask, request, jsonify

HERE        = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH  = os.path.join(HERE, 'public', 'bes4t.keras')
CLASSMAP    = os.path.join(HERE, 'public', 'class_map.json')
HOST        = os.environ.get('MODEL_HOST', '0.0.0.0')
PORT        = int(os.environ.get('MODEL_PORT', '8000'))
IMG_SIZE    = 224
# ความมั่นใจต่ำกว่าค่านี้ → ตีเป็น general ไว้ก่อน (ทิ้งลงถังทั่วไปปลอดภัยกว่าแยกผิดถัง)
# 0.40 = เกณฑ์ที่ใช้งานจริง / ตั้ง 0 เพื่อปิดฟังก์ชัน (โชว์คลาสที่ทายจริงเสมอ ตอนวัดความแม่นโมเดล)
CONF_THRESHOLD = float(os.environ.get('CONF_THRESHOLD', '0.40'))

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# คลาสย่อย -> ชนิดขยะของแอป
CLASS_TO_APP_TYPE = {
    'Battery':      'hazardous',
    'Bottle':       'recyclable',
    'Cans':         'recyclable',
    'Food':         'wet',
    'Foodpekage':   'general',
    'General':      'general',
    'Plastic Cups': 'recyclable',
}


# ---------------- camera exposure (v4l2 controls บนกล้อง USB) ----------------
# ไฟกล้องหรี่ที่ฮาร์ดแวร์ไม่ได้แล้ว ภาพตอนไฟติดจึงสว่างจนไหม้ (วัดได้ ~89% ของพิกเซล
# ชนเพดาน 250+) โมเดลเลยเห็นแต่พื้นที่ขาวโพลน ลดที่ตัวกล้องแทนด้วย v4l2:
#   brightness   0 → -64   พิกเซลไหม้ 89% → 0%   (ค่าเฉลี่ยความสว่าง 238 → 150) = ต่ำสุดที่กล้องรับ
#   gamma      214 → 100   กดต่อได้อีก ถ้ายังสว่างไป (ค่าเฉลี่ย → 157) — ปิดไว้ก่อน
# กล้องตัวนี้ (EMEET C60E) ไม่รับ exposure_time_absolute — ตั้ง manual แล้วภาพไม่ขยับเลย
# จึงเหลือแค่ brightness/gamma/gain เป็นตัวคุม
# ค่าพวกนี้อยู่กับตัวกล้องจนกว่าจะถอดสาย/รีบูต จึงตั้งซ้ำทุกครั้งที่จุดไฟกันกล้องถูกเสียบใหม่
CAMERA_V4L2_DEV   = os.environ.get('CAMERA_V4L2_DEV', '')      # ว่าง = หากล้อง USB เอง
CAMERA_BRIGHTNESS = os.environ.get('CAMERA_BRIGHTNESS', '-64') # ว่าง = ไม่แตะค่าเดิม (ช่วง -64..64)
CAMERA_GAMMA      = os.environ.get('CAMERA_GAMMA', '')         # ว่าง = ไม่แตะค่าเดิม
_v4l2_dev = None

def _find_uvc_device():
    """หา /dev/videoN ตัวแรกที่เป็นกล้อง USB จริง (Pi มี /dev/video2x ของ ISP ปนอยู่ด้วย)"""
    for i in range(10):
        dev = f'/dev/video{i}'
        if not os.path.exists(dev):
            continue
        try:
            out = subprocess.run(['v4l2-ctl', '-d', dev, '-D'],
                                 capture_output=True, text=True, timeout=3).stdout
        except FileNotFoundError:
            print('[camera] ไม่มี v4l2-ctl — ข้ามการปรับความสว่างกล้อง')
            return None
        except Exception:
            continue
        if 'uvcvideo' in out and 'Video Capture' in out:
            return dev
    print('[camera] หากล้อง USB ไม่เจอ — ข้ามการปรับความสว่างกล้อง')
    return None

def camera_tune(verbose=False):
    """ยิงค่าความสว่างลงตัวกล้อง — ทำเงียบ ๆ ล้มเหลวก็ไม่กระทบการทำงานอย่างอื่น"""
    global _v4l2_dev
    ctrls = [f'{k}={v}' for k, v in (('brightness', CAMERA_BRIGHTNESS),
                                     ('gamma', CAMERA_GAMMA)) if v != '']
    if not ctrls:
        return
    if _v4l2_dev is None:
        _v4l2_dev = _find_uvc_device() or ''
    if not _v4l2_dev:
        return
    try:
        r = subprocess.run(['v4l2-ctl', '-d', _v4l2_dev, '--set-ctrl', ','.join(ctrls)],
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            print(f'[camera] ตั้งค่ากล้องไม่สำเร็จ: {r.stderr.strip() or r.stdout.strip()}')
        elif verbose:
            print(f'[camera] {_v4l2_dev} -> {" ".join(ctrls)}')
    except Exception as e:
        print(f'[camera] ตั้งค่ากล้องไม่สำเร็จ: {e}')


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
# ดับไฟเองถ้าเงียบครบเท่านี้ (วินาที) นับใหม่ทุกครั้งที่มีคำสั่งเปิด — 0 = ปิดฟังก์ชัน
CAMERA_AUTO_OFF_S = float(os.environ.get('CAMERA_AUTO_OFF_S', '25'))
_cam_h     = None
_cam_timer = None
_cam_lock  = threading.Lock()

def _cam_level(on):
    if CAMERA_ACTIVE_LOW:
        return 0 if on else 1
    return 1 if on else 0

def _camera_auto_off():
    print(f'[camera] auto-off ({CAMERA_AUTO_OFF_S:.0f}s ไม่มีคำสั่งเข้ามา)', flush=True)
    camera_light(False)

def camera_light(on):
    """เปิด/ปิดไฟกล้อง + ตั้งเวลาดับอัตโนมัติใหม่ทุกครั้งที่เปิด

    Pi เป็นตัวเดียวที่รู้ภาพรวมทั้งระบบ การกำหนดอายุไฟจึงอยู่ที่นี่ ไม่ใช่ที่ ESP
    (ESP เห็นแค่ระยะจากเซ็นเซอร์ ไม่รู้ว่าเว็บถ่ายเสร็จหรือยัง) หน้าที่ของ ESP
    เหลือแค่ "จุดไฟให้เร็ว" อย่างเดียว
    """
    global _cam_timer
    if not _LGPIO_OK or _cam_h is None:
        return
    with _cam_lock:
        lgpio.gpio_write(_cam_h, CAMERA_PIN, _cam_level(on))
        if _cam_timer is not None:
            _cam_timer.cancel()
            _cam_timer = None
        if on and CAMERA_AUTO_OFF_S > 0:
            _cam_timer = threading.Timer(CAMERA_AUTO_OFF_S, _camera_auto_off)
            _cam_timer.daemon = True
            _cam_timer.start()
    if on:
        # นอก lock + แยก thread — v4l2-ctl ใช้เวลาราว 100ms ปล่อยให้ไฟติดไปก่อน
        threading.Thread(target=camera_tune, daemon=True).start()

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
camera_tune(verbose=True)


# ---------------- model (EfficientNetV2-S backbone + custom head) ----------------
class WasteModel(nn.Module):
    def __init__(self, n_classes):
        super().__init__()
        self.backbone = M.efficientnet_v2_s(weights=None)   # ใช้เฉพาะ .features + .avgpool
        self.head = nn.Sequential(
            nn.Dropout(0.3),              # head.0 (ไม่มี params)
            nn.Linear(1280, n_classes),   # head.1
        )

    def forward(self, x):
        x = self.backbone.features(x)
        x = self.backbone.avgpool(x)
        x = torch.flatten(x, 1)
        return self.head(x)


def _extract_state(obj):
    """ดึง state_dict ออกมา + เมทาดาทาที่ห่อมาด้วย (คนเทรนใช้ชื่อคีย์ไม่ตรงกัน)"""
    if not isinstance(obj, dict):
        raise SystemExit(f'[model] ไฟล์ไม่ใช่ dict/state_dict — {MODEL_PATH}')
    is_sd = lambda d: isinstance(d, dict) and d and all(
        hasattr(t, 'shape') for t in list(d.values())[:3])
    for key in ('model_state', 'model', 'state_dict'):
        if is_sd(obj.get(key)):
            return obj[key], obj
    if is_sd(obj):
        return obj, {}
    raise SystemExit(f'[model] หา state_dict ใน checkpoint ไม่เจอ — คีย์ที่มี: {list(obj)[:8]}')


def _build_model(state, meta, n_classes):
    """เลือกสถาปัตยกรรมให้ตรงกับน้ำหนัก แล้วปรับชั้นสุดท้ายเป็น n_classes"""
    cfg  = meta.get('cfg') if isinstance(meta.get('cfg'), dict) else {}
    name = str(cfg.get('model') or meta.get('arch') or '').lower()

    if any(k.startswith('backbone.') for k in state):
        return WasteModel(n_classes), 'WasteModel (backbone + head)'

    # mobilenet_v2 กับ efficientnet_v2_s ตั้งชื่อเลเยอร์ชุดเดียวกัน (features.* + classifier.1)
    # และชั้นสุดท้ายเป็น Linear(1280, n) เท่ากันด้วย แยกด้วยชั้นสุดท้ายไม่ได้ —
    # ต้องนับบล็อกใน features แทน (mobilenet_v2 มี 0-18, efficientnet_v2_s มี 0-7)
    if not name:
        depth = max((int(k.split('.')[1]) for k in state
                     if k.startswith('features.') and k.split('.')[1].isdigit()), default=0)
        name  = 'mobilenet_v2' if depth > 8 else 'efficientnet_v2_s'

    builder = {'mobilenet_v2': M.mobilenet_v2,
               'efficientnet_v2_s': M.efficientnet_v2_s}.get(name)
    if builder is None:
        raise SystemExit(f'[model] ไม่รู้จักสถาปัตยกรรม {name!r} — {MODEL_PATH}')
    m = builder(weights=None)
    m.classifier[1] = nn.Linear(m.classifier[1].in_features, n_classes)
    return m, f'torchvision {name}'


def _load_onnx():
    """โมเดล ONNX (แปลงมาจาก Keras) — คนละธรรมเนียมกับ PyTorch ทุกอย่าง

    PyTorch: NCHW, พิกเซล 0-1, normalize ด้วย mean/std, output เป็น logits
    ตัวนี้  : NHWC, พิกเซล 0-255 ดิบ ๆ (rescaling อยู่ในกราฟแล้ว), output softmax แล้ว
    ป้อนผิดธรรมเนียมจะได้ผลมั่วโดยไม่มี error โผล่มา จึงอ่านจาก metadata ในไฟล์เป็นหลัก
    """
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    meta = sess.get_modelmeta().custom_metadata_map or {}
    inp  = sess.get_inputs()[0]
    size = int(meta.get('img_size') or IMG_SIZE)

    classes = [c.strip() for c in meta['classes'].split(',')] if meta.get('classes') else None
    if classes is None:
        with open(CLASSMAP, encoding='utf-8') as f:
            classes = json.load(f)['classes']

    n_out = sess.get_outputs()[0].shape[-1]
    if isinstance(n_out, int) and n_out != len(classes):
        raise SystemExit(f'[model] จำนวนคลาสไม่ตรง: โมเดลออก {n_out} แต่มีชื่อคลาส {len(classes)}')

    def infer(img):
        a = np.asarray(img.convert('RGB').resize((size, size), Image.BILINEAR), dtype=np.float32)
        out = np.asarray(sess.run(None, {inp.name: a[None, ...]})[0][0], dtype=np.float64)
        # กราฟนี้มี softmax ในตัว (ผลรวม=1) แต่เผื่อรุ่นที่ export มาเป็น logits
        if out.min() < 0 or not 0.99 <= out.sum() <= 1.01:
            e = np.exp(out - out.max()); out = e / e.sum()
        return [float(v) for v in out]

    print(f'[model] loaded {MODEL_PATH}')
    print(f'[model] arch: onnx {meta.get("source_model", "?")}  img_size: {size}  input: {inp.shape} (NHWC 0-255)')
    print(f'[model] classes: {classes}  (จาก {"metadata ในไฟล์" if meta.get("classes") else "class_map.json"})')
    return infer, classes


def _load_keras():
    """โมเดล Keras 3 (.keras/.h5) — ธรรมเนียมเดียวกับ .onnx ที่แปลงมาจาก Keras

    NHWC, พิกเซล 0-255 ดิบ ๆ (Rescaling อยู่ในกราฟแล้ว), output softmax แล้ว
    ไฟล์ .keras ไม่ได้เก็บชื่อคลาสไว้ จึงอ่านลำดับคลาสจาก class_map.json เสมอ
    (ลำดับต้องตรงกับตอนเทรน = เรียงตามตัวอักษรของชื่อโฟลเดอร์)
    """
    os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
    import numpy as np
    import keras

    model = keras.saving.load_model(MODEL_PATH, compile=False)

    with open(CLASSMAP, encoding='utf-8') as f:
        classes = json.load(f)['classes']

    n_out = model.output_shape[-1]
    if isinstance(n_out, int) and n_out != len(classes):
        raise SystemExit(f'[model] จำนวนคลาสไม่ตรง: โมเดลออก {n_out} แต่ class_map มี {len(classes)}')

    shape = model.input_shape
    size  = int(shape[1]) if len(shape) == 4 and shape[1] else IMG_SIZE

    def infer(img):
        a = np.asarray(img.convert('RGB').resize((size, size), Image.BILINEAR), dtype=np.float32)
        out = np.asarray(model.predict(a[None, ...], verbose=0)[0], dtype=np.float64)
        # ชั้นสุดท้ายเป็น softmax อยู่แล้ว แต่เผื่อรุ่นที่เซฟมาเป็น logits
        if out.min() < 0 or not 0.99 <= out.sum() <= 1.01:
            e = np.exp(out - out.max()); out = e / e.sum()
        return [float(v) for v in out]

    infer(Image.new('RGB', (size, size)))   # วอร์มอัพ ให้ครั้งแรกของจริงไม่ช้า

    print(f'[model] loaded {MODEL_PATH}')
    print(f'[model] arch: keras {model.name}  img_size: {size}  input: {shape} (NHWC 0-255)')
    print(f'[model] classes: {classes}  (จาก class_map.json)')
    return infer, classes


def _load_torch():
    """โหลดโมเดล + สร้าง transform ให้ตรงกับที่ใช้ตอนเทรน

    checkpoint แต่ละไฟล์ห่อไม่เหมือนกัน (state_dict เปล่า / ห่อใน model_state /
    ห่อใน model) และใช้สถาปัตยกรรมคนละตัว ถ้าจับคู่ผิดแล้วโหลดแบบ strict=False
    จะได้โมเดลน้ำหนักสุ่มโดยไม่มี error โผล่มาเลย จึงตรวจ missing/unexpected เองทุกครั้ง

    ค่า normalize ก็สำคัญพอกัน — best1_1.pt เทรนด้วย mean/std ของชุดข้อมูลเอง
    (~0.63/0.25) ไม่ใช่ ImageNet (~0.49/0.23) ถ้าใช้ผิดภาพจะเพี้ยนไปราวครึ่ง SD
    จึงอ่านจาก checkpoint มาก่อนเสมอ แล้วค่อย fallback เป็น ImageNet
    """
    obj = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    state, meta = _extract_state(obj)

    classes = meta.get('classes')
    if classes is None:
        with open(CLASSMAP, encoding='utf-8') as f:
            classes = json.load(f)['classes']

    n_out = state['classifier.1.weight'].shape[0] if 'classifier.1.weight' in state else len(classes)
    if n_out != len(classes):
        raise SystemExit(f'[model] จำนวนคลาสไม่ตรง: checkpoint มี {n_out} '
                         f'แต่ class_map มี {len(classes)} — {MODEL_PATH}')

    model, arch = _build_model(state, meta, len(classes))
    res = model.load_state_dict(state, strict=False)
    # ยอมให้ขาดได้เฉพาะ backbone.classifier ที่ WasteModel ไม่ได้เรียกใช้ นอกนั้นถือว่าจับคู่ผิด
    missing = [k for k in res.missing_keys if not k.startswith('backbone.classifier.')]
    if missing or res.unexpected_keys:
        raise SystemExit(f'[model] น้ำหนักไม่ตรงกับสถาปัตยกรรม {arch}\n'
                         f'  missing   : {missing[:4]}\n'
                         f'  unexpected: {res.unexpected_keys[:4]}')
    model.eval().to(DEVICE)

    cfg  = meta.get('cfg') if isinstance(meta.get('cfg'), dict) else {}
    mean = meta.get('mean') or [0.485, 0.456, 0.406]
    std  = meta.get('std')  or [0.229, 0.224, 0.225]
    size = int(cfg.get('img_size') or IMG_SIZE)
    tf = T.Compose([T.Resize((size, size)), T.ToTensor(), T.Normalize(mean=mean, std=std)])

    src = 'จาก checkpoint' if meta.get('mean') else 'ImageNet (checkpoint ไม่ได้ระบุ)'
    print(f'[model] loaded {MODEL_PATH}')
    print(f'[model] arch: {arch}  ({len(state)} tensors)  img_size: {size}')
    print(f'[model] normalize {src}: mean={[round(v,3) for v in mean]} std={[round(v,3) for v in std]}')
    print(f'[model] classes: {classes}  val_macro_f1: {meta.get("val_macro_f1")}  device: {DEVICE}')

    def infer(img):
        x = tf(img).unsqueeze(0).to(DEVICE)
        with torch.no_grad():
            return torch.softmax(model(x), dim=1)[0].cpu().tolist()

    return infer, classes


def load_model():
    """เลือก backend ตามนามสกุลไฟล์ แล้วคืนฟังก์ชัน infer(PIL image) -> list ความน่าจะเป็น"""
    low = MODEL_PATH.lower()
    if low.endswith('.onnx'):
        return _load_onnx()
    if low.endswith(('.keras', '.h5')):
        return _load_keras()
    return _load_torch()


INFER, CLASSES = load_model()


app = Flask(__name__)


@app.after_request
def add_cors(resp):
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

    probs = INFER(img)

    best_idx = int(max(range(len(probs)), key=lambda i: probs[i]))
    conf = float(probs[best_idx])
    model_class = CLASSES[best_idx]
    app_type = CLASS_TO_APP_TYPE.get(model_class, 'general')

    # ความมั่นใจต่ำกว่าเกณฑ์ → ตีเป็นขยะทั่วไป (general) ไว้ก่อน
    # ปิดฟังก์ชันได้ด้วย CONF_THRESHOLD = 0 (ค่าเริ่มต้นคือ 0.40)
    low_conf = CONF_THRESHOLD > 0 and conf < CONF_THRESHOLD
    if low_conf:
        app_type = 'general'

    detail = '  '.join(f'{c}={p:.2f}' for c, p in zip(CLASSES, probs))
    tag = ' [LOW→general]' if low_conf else ''
    print(f'[predict] {model_class} ({conf:.0%}) -> {app_type}{tag}   [{detail}]', flush=True)

    return jsonify({
        'type':          app_type,        # ชนิดขยะที่แอปใช้ (recyclable/hazardous/wet/general)
        'modelClass':    model_class,     # คลาสย่อยดิบ (Bottle/Cans/Plastic_cup/...)
        'confidence':    conf,
        'lowConfidence': low_conf,        # true = ความมั่นใจต่ำ ถูกตีเป็น general
        'probs':         probs,
        'classes':       CLASSES,
        'idx':           best_idx,
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
