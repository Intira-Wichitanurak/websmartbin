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

import torch
import torch.nn as nn
import torchvision.models as M
import torchvision.transforms as T
from PIL import Image
from flask import Flask, request, jsonify

HERE        = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH  = os.path.join(HERE, 'public', 'best_model.pt')
CLASSMAP    = os.path.join(HERE, 'public', 'class_map.json')
HOST        = os.environ.get('MODEL_HOST', '0.0.0.0')
PORT        = int(os.environ.get('MODEL_PORT', '8000'))

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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'classes': CLASSES, 'device': str(DEVICE)})


if __name__ == '__main__':
    print(f'[server] listening on http://{HOST}:{PORT}  (POST /classify)')
    app.run(host=HOST, port=PORT, threaded=True)
