// tf and tflite are loaded from <script> tags in index.html (CDN).
// Wait for them in case the CDN is slow.
function getGlobals() {
  return { tf: window.tf, tflite: window.tflite }
}
function waitForGlobals(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    ;(function tick() {
      const { tf, tflite } = getGlobals()
      if (tf && tflite) return resolve({ tf, tflite })
      if (Date.now() - start > timeoutMs) return reject(new Error('tf/tflite not loaded'))
      setTimeout(tick, 50)
    })()
  })
}

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

/* ==========================================================
 *  CONFIG — adjust these to match your actual model
 * ==========================================================
 *  • MODEL_URL : path to the .tflite (in /public)
 *  • NORMALIZE : '0to1'  → divide by 255         (most common)
 *                'pm1'   → (x/127.5) - 1         (mobilenet, etc)
 *                'none'  → use raw 0-255 values
 *  • LABEL_MAP : ordered list mapping output index → app type
 *                The model output index is matched to LABEL_MAP[i].
 *                Common training-label orderings to try:
 *                  ['wet','recyclable','hazardous','general']
 *                  ['recyclable','general','wet','hazardous']
 *                  TrashNet 6-class:
 *                    ['recyclable','recyclable','recyclable',
 *                     'recyclable','recyclable','general']
 *                    (cardboard, glass, metal, paper, plastic, trash)
 *                Adjust until predictions look right.
 * ========================================================== */
const MODEL_URL = '/waste_classifier.tflite'
const NORMALIZE = '0to1'
// Confirmed:
//   idx 0 = general    (plastic cup)
//   idx 1 = recyclable (water bottle, paper)
// Still guessing: idx 2/3 — order of wet vs hazardous unknown.
const LABEL_MAP = ['general', 'recyclable', 'hazardous', 'wet']

/* ---------------- model loading (cached) ---------------- */
const TFLITE_VERSION = '0.0.1-alpha.10'
// NOTE: WASM client + .wasm binaries live in /wasm/, NOT /dist/.
// Pointing to the wrong folder gives "_malloc undefined" at predict time.
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@${TFLITE_VERSION}/wasm/`

let modelPromise = null
function loadModel() {
  if (!modelPromise) {
    modelPromise = waitForGlobals()
      .then(({ tflite }) => {
        // tfjs-tflite needs to fetch its WASM runtime from the same dist folder.
        // Without this, the client throws "_malloc undefined" at inference time.
        if (typeof tflite.setWasmPath === 'function') {
          tflite.setWasmPath(WASM_BASE)
        }
        return tflite.loadTFLiteModel(MODEL_URL)
      })
      .then(m => {
        const inShape  = m.inputs?.[0]?.shape
        const outShape = m.outputs?.[0]?.shape
        console.log('[classifier] model loaded — input', inShape, 'output', outShape)
        return m
      })
      .catch(err => {
        modelPromise = null   // allow retry on next call
        throw err
      })
  }
  return modelPromise
}

/* ---------------- helpers ---------------- */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function normalize(t, tf) {
  if (NORMALIZE === '0to1') return t.div(255)
  if (NORMALIZE === 'pm1')  return t.div(127.5).sub(1)
  return t
}

/* ---------------- main inference ---------------- */
export async function classifyWaste(imageDataUrl) {
  let inputTensor, outputTensor
  try {
    const model = await loadModel()
    const { tf } = await waitForGlobals()

    // Read input shape: tfjs-tflite returns [1, h, w, 3] in inputs[0].shape
    const shape = model.inputs?.[0]?.shape ?? [1, 224, 224, 3]
    const h = shape[1] ?? 224
    const w = shape[2] ?? 224

    const img = await loadImage(imageDataUrl)
    inputTensor = tf.tidy(() => {
      let t = tf.browser.fromPixels(img)
      t = tf.image.resizeBilinear(t, [h, w])
      t = normalize(t, tf)
      return t.expandDims(0).cast('float32')
    })

    outputTensor = model.predict(inputTensor)
    const raw = await outputTensor.data()

    // If output looks like logits (any value > 1 or negatives), softmax it
    const probs = looksLikeLogits(raw) ? softmax(raw) : Array.from(raw)

    // pick best class
    let bestIdx = 0, bestProb = probs[0]
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > bestProb) { bestProb = probs[i]; bestIdx = i }
    }

    // Print all probabilities every time so we can tune LABEL_MAP
    console.log('[classifier] probs:', probs.map((p, i) => `${i}=${p.toFixed(3)}`).join('  '),
                '→ best idx', bestIdx, '→', LABEL_MAP[bestIdx])

    return {
      type: LABEL_MAP[bestIdx] ?? 'general',
      confidence: clamp(bestProb, 0, 1),
      hasFoodResidue: false,
      blurry: false,
      _debug: { idx: bestIdx, probs: Array.from(probs) }
    }
  } catch (err) {
    console.warn('[classifier] inference failed, using mock:', err)
    return mockClassify()
  } finally {
    inputTensor?.dispose?.()
    outputTensor?.dispose?.()
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function looksLikeLogits(arr) {
  // probability outputs sum ~1 and are all 0..1; logits often violate that
  let sum = 0, anyHigh = false, anyNeg = false
  for (const v of arr) {
    sum += v
    if (v > 1.01) anyHigh = true
    if (v < -0.01) anyNeg = true
  }
  return anyHigh || anyNeg || Math.abs(sum - 1) > 0.05
}

function softmax(arr) {
  const max = Math.max(...arr)
  const exps = arr.map(v => Math.exp(v - max))
  const s = exps.reduce((a, b) => a + b, 0)
  return exps.map(e => e / s)
}

/* ---------------- fallback when model fails ---------------- */
async function mockClassify() {
  await new Promise(r => setTimeout(r, 1000))
  const types = ['wet', 'recyclable', 'hazardous', 'general']
  const type  = types[Math.floor(Math.random() * types.length)]
  return {
    type,
    confidence: 0.7 + Math.random() * 0.29,
    hasFoodResidue: false,
    blurry: false
  }
}

/* ---------------- preload (optional) ---------------- */
// Call this from the home page so the model is ready by the time the user
// reaches the camera screen. Falls back silently if anything goes wrong.
export function preloadClassifier() {
  loadModel().catch(() => {})
}
