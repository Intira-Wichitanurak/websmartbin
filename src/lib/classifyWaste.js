// Inference runs in a Python server (model_server.py) that loads best_model.pt
// (EfficientNetV2-S, PyTorch). The browser POSTs the captured photo and gets
// back the predicted waste type. Configure the URL via Vite env:
//     VITE_MODEL_API_URL=http://192.168.1.50:8000/classify
// Default: http://localhost:8000/classify
const MODEL_API_URL = import.meta.env?.VITE_MODEL_API_URL || 'http://localhost:8000/classify'

/* ==========================================================
 *  Display info per category — used by ResultPage UI
 * ========================================================== */
export const WASTE_TYPES = {
  wet: {
    key: 'wet',
    label: 'ขยะเปียก',
    emoji: '🍃',
    color: 'from-emerald-300 to-leaf-500',
    ring:  'ring-emerald-300',
    text:  'text-emerald-800',
    tip:   'เช่น เศษอาหาร เปลือกผลไม้ ใบไม้ — ทิ้งในถังสีเขียว เพื่อนำไปทำปุ๋ยหมัก'
  },
  recyclable: {
    key: 'recyclable',
    label: 'ขยะรีไซเคิล',
    emoji: '♻️',
    color: 'from-sky-300 to-sky-500',
    ring:  'ring-sky-300',
    text:  'text-sky-800',
    tip:   'เช่น ขวดน้ำ กระดาษ กระป๋อง — ล้างให้สะอาดก่อนทิ้งในถังสีเหลือง'
  },
  hazardous: {
    key: 'hazardous',
    label: 'ขยะอันตราย',
    emoji: '⚠️',
    color: 'from-rose-300 to-rose-500',
    ring:  'ring-rose-300',
    text:  'text-rose-800',
    tip:   'เช่น ถ่านไฟฉาย หลอดไฟ ยา — ทิ้งในถังสีแดงโดยเฉพาะ ห้ามปนกับขยะอื่น'
  },
  general: {
    key: 'general',
    label: 'ขยะทั่วไป',
    emoji: '🗑️',
    color: 'from-amber-300 to-amber-500',
    ring:  'ring-amber-300',
    text:  'text-amber-800',
    tip:   'เช่น ถุงพลาสติก ซองขนม โฟม — ทิ้งในถังสีน้ำเงิน'
  }
}

/* ---------------- main inference (calls Python server) ---------------- */
export async function classifyWaste(imageDataUrl) {
  try {
    const res = await fetch(MODEL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl }),
    })
    if (!res.ok) throw new Error(`server ${res.status}`)
    const data = await res.json()

    console.log('[classifier]', data.modelClass, '→', data.type,
                '  probs:', (data.probs || []).map((p, i) => `${data.classes?.[i] ?? i}=${p.toFixed(3)}`).join('  '))

    return {
      type: data.type ?? 'general',
      modelClass: data.modelClass,    // CameraPage ใช้เลือก threshold เศษอาหารต่อชนิด
      confidence: clamp(data.confidence ?? 0, 0, 1),
      hasFoodResidue: false,          // มาจาก load cell ใน CameraPage แทน
      blurry: false,
      _debug: { idx: data.idx, modelClass: data.modelClass, probs: data.probs ?? [] },
    }
  } catch (err) {
    console.warn('[classifier] server inference failed, using mock:', err)
    return mockClassify()
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/* ---------------- fallback when server is unreachable ---------------- */
async function mockClassify() {
  await new Promise(r => setTimeout(r, 1000))
  const types = ['recyclable', 'general']
  const type  = types[Math.floor(Math.random() * types.length)]
  return {
    type,
    confidence: 0.7 + Math.random() * 0.29,
    hasFoodResidue: false,
    blurry: false,
  }
}

/* ---------------- preload (optional) ---------------- */
// Ping the server's /health so the first real request isn't cold.
// Falls back silently if the server isn't up yet.
export function preloadClassifier() {
  const healthUrl = MODEL_API_URL.replace(/\/classify\/?$/, '/health')
  fetch(healthUrl).catch(() => {})
}
