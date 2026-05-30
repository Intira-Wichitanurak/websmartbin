import { useEffect, useRef, useState } from 'react'
import Capybara from '../components/Capybara.jsx'
import { classifyWaste } from '../lib/classifyWaste.js'
import { sfx, playVoice } from '../lib/sounds.js'
import { getSensor } from '../lib/sensor.js'

// เฉพาะ "กระป๋อง" (modelClass === 'Cans') ถ้าน้ำหนัก > เกณฑ์นี้ ถือว่ามีเศษอาหารติด
// → เด้ง popup ให้เคาะทิ้งก่อน. ขยะประเภทอื่นไม่เช็คน้ำหนัก
const FOOD_THRESHOLD_GRAMS = 200

/**
 * Auto-capture flow:
 *   watching   → user has not placed anything yet
 *   scanning   → motion detected, waiting for the scene to settle
 *   capturing  → snapping the photo (brief flash)
 *   processing → running the classifier
 *
 * The "real model" replacement just needs to swap classifyWaste(); the
 * trigger logic stays the same. Motion detection is a placeholder until
 * a real object detector is wired in.
 */
const MOVEMENT_THRESHOLD = 6     // avg per-channel pixel diff that counts as motion
const STABLE_DURATION    = 1500  // ms of stillness AFTER motion → trigger capture
const POLL_INTERVAL      = 250   // ms between motion samples
const SAMPLE_SIZE        = 64    // px — downsample frame for cheap diffs
const WARMUP_MS          = 800   // give the video a moment before sampling

export default function CameraPage({ onResult }) {
  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const streamRef   = useRef(null)
  const sampleRef   = useRef(null)
  const lastFrame   = useRef(null)
  const lastMotion  = useRef(0)
  const hasMovedRef = useRef(false)

  // phase: init | denied | unsupported | watching | scanning | capturing | processing
  const [phase, setPhase] = useState('init')

  /* ---------------- start camera ---------------- */
  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setPhase('unsupported'); return
      }
      // ลอง back camera ก่อน (มือถือ/แท็บเล็ตจะได้กล้องหลัง) — ถ้าไม่ได้
      // (เช่น USB webcam บน PC/Pi ไม่มี facingMode) → fallback เป็นกล้องอะไรก็ได้
      async function openCamera() {
        try {
          return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false
          })
        } catch (e) {
          console.warn('[camera] environment-facing failed, falling back to any camera:', e?.name || e)
          return await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        }
      }
      try {
        const stream = await openCamera()
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setPhase('watching')
      } catch (e) {
        console.error('[camera] getUserMedia failed:', e)
        setPhase('denied')
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  /* ---------------- motion-detection loop ---------------- */
  useEffect(() => {
    if (phase !== 'watching' && phase !== 'scanning') return

    if (!sampleRef.current) {
      const c = document.createElement('canvas')
      c.width = SAMPLE_SIZE
      c.height = SAMPLE_SIZE
      sampleRef.current = c
    }
    const ctx = sampleRef.current.getContext('2d', { willReadFrequently: true })

    let pollId
    function tick() {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      ctx.drawImage(v, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const cur = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data

      if (lastFrame.current) {
        const prev = lastFrame.current
        let sum = 0
        for (let i = 0; i < cur.length; i += 4) {
          sum += Math.abs(cur[i]   - prev[i])
              +  Math.abs(cur[i+1] - prev[i+1])
              +  Math.abs(cur[i+2] - prev[i+2])
        }
        const avg = sum / (SAMPLE_SIZE * SAMPLE_SIZE * 3)

        if (avg > MOVEMENT_THRESHOLD) {
          hasMovedRef.current = true
          lastMotion.current = Date.now()
          setPhase(p => {
            if (p !== 'scanning') sfx.click()   // chirp when first detected
            return 'scanning'
          })
        } else if (hasMovedRef.current && Date.now() - lastMotion.current > STABLE_DURATION) {
          clearInterval(pollId)
          autoCapture()
        }
      }
      lastFrame.current = new Uint8ClampedArray(cur)
    }

    const warm = setTimeout(() => { pollId = setInterval(tick, POLL_INTERVAL) }, WARMUP_MS)
    return () => { clearTimeout(warm); clearInterval(pollId) }
  }, [phase])

  /* ---------------- capture + classify ---------------- */
  async function autoCapture() {
    setPhase('capturing')
    sfx.shutter()                                 // 📷 click!
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) return
    const w = v.videoWidth || 640
    const h = v.videoHeight || 480
    c.width = w; c.height = h
    c.getContext('2d').drawImage(v, 0, 0, w, h)
    const dataUrl = c.toDataURL('image/jpeg', 0.9)

    // brief shutter "flash" beat before processing screen
    await new Promise(r => setTimeout(r, 350))
    sfx.thinking()                                // 🤔 hmm sound

    setPhase('processing')
    const result = await classifyWaste(dataUrl)

    // เช็คเศษอาหารเฉพาะตอนทายเป็น "กระป๋อง" — ถ้าน้ำหนักจาก load cell > 200g
    // ถือว่ายังมีเศษอาหารติดอยู่ (เช่น น้ำในกระป๋อง / เศษอาหาร). ขยะอื่นข้ามไป
    const grams = getSensor().lastWeight()
    const hasFoodResidue =
      result.modelClass === 'Cans' &&
      typeof grams === 'number' &&
      grams > FOOD_THRESHOLD_GRAMS

    onResult({ image: dataUrl, ...result, hasFoodResidue, weight: grams })
  }

  /* ---------------- right-column status copy ----------------
     `text`   — what shows in the bubble
     `speech` — what the mascot says (only for phases that have time to talk;
                quick phases like scanning/capturing just rely on sfx + visual)
  */
  const rightCopy = {
    init:        { mood: 'happy',  text: 'กำลังเปิดกล้องน้า...',  speech: '' },
    watching:    { mood: 'happy',  text: 'วางขยะตรงหน้าคาปิเลยน้า~', speech: 'วางขยะตรงหน้าน้องคาปิ จะช่วยแยกประเภทให้น้า' },
    scanning:    { mood: 'happy',  text: 'เห็นแล้ว ถือนิ่ง ๆ น้า!',  speech: '' },
    capturing:   { mood: 'starry', text: 'ถ่ายภาพแล้ว!',           speech: '' },
    processing:  { mood: 'starry', text: 'น้องคาปิกำลังคิด...',     speech: 'น้องคาปิกำลังคิดอยู่นะ รอแป๊บนึงน้า' },
    denied:      { mood: 'sad',    text: 'กล้องยังไม่เปิดน้า',      speech: 'กล้องยังไม่เปิดเลยน้า ลองกดอนุญาตดูสิ' },
    unsupported: { mood: 'sad',    text: 'เครื่องนี้ใช้กล้องไม่ได้', speech: 'เครื่องนี้ใช้กล้องไม่ได้น้า' }
  }[phase] ?? { mood: 'happy', text: '', speech: '' }

  // Speak the line politely — wait for any in-progress speech (e.g. the
  // welcome from the home page) to finish first, then say our line.
  // Bails out cleanly if the phase changes before we get our turn.
  useEffect(() => {
    if (!rightCopy.speech) return
    const SS = window.speechSynthesis
    let cancelled = false

    function tryToSpeak() {
      if (cancelled) return
      if (SS && (SS.speaking || SS.pending)) {
        setTimeout(tryToSpeak, 200)
      } else {
        playVoice(phase, rightCopy.speech)
      }
    }
    const initialDelay = setTimeout(tryToSpeak, 150)

    return () => {
      cancelled = true
      clearTimeout(initialDelay)
    }
  }, [phase])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="card w-full h-full max-h-[500px] p-4 overflow-hidden flex flex-col relative">

        {/* corner decorations */}
        <span className="absolute top-2 left-2 text-xl animate-twinkle z-10">📸</span>
        <span className="absolute top-2 right-2 text-lg animate-sparkle z-10" style={{ animationDelay: '.5s' }}>✨</span>
        <span className="absolute bottom-2 left-2 text-base animate-sparkle z-10" style={{ animationDelay: '.9s' }}>🌟</span>

        {/* header bar — fully automatic flow, no manual buttons */}
        <div className="flex items-center justify-center mb-2 shrink-0 relative z-10">
          <h2 className="text-xl font-extrabold leading-tight">
            <span className="animate-wiggle inline-block mr-1">📸</span>
            <span className="bg-gradient-to-b from-sky-500 to-sky-700 bg-clip-text text-transparent">
              ถ่ายภาพขยะ
            </span>
          </h2>
        </div>

        {/* main row */}
        <div className="grid grid-cols-[1fr_360px] gap-4 flex-1 min-h-0">

          {/* CAMERA */}
          <div className="relative rounded-[1.25rem] overflow-hidden ring-4 ring-white shadow-soft bg-bubble-cream h-full">
            <video
              ref={videoRef}
              playsInline
              muted
              className={`w-full h-full object-cover ${phase === 'denied' || phase === 'unsupported' || phase === 'init' ? 'opacity-0' : ''}`}
            />

            {/* corner brackets — visible whenever we're actively framing */}
            {(phase === 'watching' || phase === 'scanning') && (
              <>
                <Bracket cls={`top-2 left-2 border-t-4 border-l-4 rounded-tl-2xl ${phase === 'scanning' ? 'border-emerald-400' : 'border-white'}`} />
                <Bracket cls={`top-2 right-2 border-t-4 border-r-4 rounded-tr-2xl ${phase === 'scanning' ? 'border-emerald-400' : 'border-white'}`} />
                <Bracket cls={`bottom-2 left-2 border-b-4 border-l-4 rounded-bl-2xl ${phase === 'scanning' ? 'border-emerald-400' : 'border-white'}`} />
                <Bracket cls={`bottom-2 right-2 border-b-4 border-r-4 rounded-br-2xl ${phase === 'scanning' ? 'border-emerald-400' : 'border-white'}`} />

                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 animate-bob">
                  <div className={`bubble text-xs px-3 py-1 whitespace-nowrap ${phase === 'scanning' ? 'ring-emerald-300' : ''}`}>
                    {phase === 'scanning' ? 'เห็นแล้ว! ถือนิ่ง ๆ น้า~' : 'วางขยะให้น้องคาปิดูเลย!'}
                  </div>
                </div>
              </>
            )}

            {/* scanning ring pulse */}
            {phase === 'scanning' && (
              <div className="absolute inset-0 ring-4 ring-emerald-400/70 rounded-[1.25rem] animate-pulse pointer-events-none" />
            )}

            {/* shutter flash */}
            {phase === 'capturing' && (
              <div className="absolute inset-0 bg-white animate-pop pointer-events-none" />
            )}

            {/* placeholder for camera errors */}
            {(phase === 'denied' || phase === 'unsupported' || phase === 'init') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4 gap-2">
                <Capybara size={200} mood={phase === 'init' ? 'happy' : 'sad'} />
                {phase === 'init'        && <p className="text-sky-700 font-semibold text-sm">กำลังเปิดกล้องน้า...</p>}
                {phase === 'denied'      && <p className="text-rose-700 font-bold text-sm">กล้องยังไม่เปิด 😢<br/><span className="font-semibold text-sky-700">โปรดอนุญาตให้ใช้กล้องน้า 💛</span></p>}
                {phase === 'unsupported' && <p className="text-rose-700 font-bold text-sm">เครื่องนี้ใช้กล้องไม่ได้ 😢<br/><span className="font-semibold text-sky-700">ลองเปิดในเบราว์เซอร์อื่นน้า 💛</span></p>}
              </div>
            )}

            {/* processing overlay */}
            {phase === 'processing' && (
              <div className="absolute inset-0 bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center">
                <Capybara size={400} mood="thinking" />
                <p className="-mt-20 text-sky-700 font-bold animate-pulse text-sm">น้องคาปิกำลังคิด... 🤔</p>
                <div className="flex gap-1 mt-1">
                  <span className="w-2 h-2 rounded-full bg-capy-400 animate-bounce" />
                  <span className="w-2 h-2 rounded-full bg-capy-400 animate-bounce" style={{ animationDelay: '.15s' }} />
                  <span className="w-2 h-2 rounded-full bg-capy-400 animate-bounce" style={{ animationDelay: '.3s' }} />
                </div>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN — mascot scene */}
          <div className="flex flex-col items-center justify-between gap-1 h-full py-1 relative">
            <div className="bubble text-xs animate-bob shrink-0 z-10" style={{ animationDuration: '2.4s' }}>
              {rightCopy.text}
            </div>

            {/* floating items around mascot */}
            <div className="flex-1 flex items-center justify-center min-h-0 relative w-full">
              <span className="absolute top-2 left-2 text-xl animate-floaty z-10">🔍</span>
              <span className="absolute top-6 right-2 text-xl animate-floaty z-10" style={{ animationDelay: '.6s' }}>🎯</span>
              <span className="absolute bottom-4 left-1 text-base animate-twinkle z-10" style={{ animationDelay: '.3s' }}>✨</span>
              <span className="absolute bottom-6 right-1 text-base animate-twinkle z-10" style={{ animationDelay: '.8s' }}>⭐</span>
              <Capybara size={320} mood={rightCopy.mood} src="/mascos3.png" />
            </div>

            <p className="text-center text-[11px] text-sky-600/80 font-semibold leading-snug">
              ระบบจะถ่ายเองเมื่อขยะนิ่งน้า 💡
            </p>
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  )
}

function Bracket({ cls }) {
  return <div className={`absolute w-8 h-8 drop-shadow-md transition-colors ${cls}`} />
}
