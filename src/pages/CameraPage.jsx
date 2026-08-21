import { useEffect, useRef, useState } from 'react'
import Capybara from '../components/Capybara.jsx'
import { classifyWaste } from '../lib/classifyWaste.js'
import { sfx, playVoice } from '../lib/sounds.js'
import { getSensor } from '../lib/sensor.js'

// เกณฑ์น้ำหนักเศษอาหารต่อชนิดขยะ (ตาม modelClass จากโมเดล)
// น้ำหนักจาก HX711 > เกณฑ์ของชนิดนั้น = ถือว่ามีเศษอาหารติด → เด้ง popup ให้เคาะทิ้งก่อน
// ชนิดที่ไม่อยู่ในตาราง (เช่น General) จะข้ามการเช็คน้ำหนัก
const FOOD_THRESHOLD_GRAMS = {
  Bottle:    80,
  Cans:      38,
  Foodpekage:  50,
  // General — ไม่เช็ค
}

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
const POLL_INTERVAL      = 250   // ms between motion samples
const SAMPLE_SIZE        = 64    // px — downsample frame for cheap diffs
const WARMUP_MS          = 800   // give the video a moment before sampling

// จับภาพด้วยเซนเซอร์: ให้คนวางของแล้ว "เอามือออก" (ultrasonic กลับมา >45cm →
// node #1 ส่ง cleared) ค่อยถ่าย — กันมือติดในเฟรม
const CAPTURE_DELAY_MS = 3000    // หน่วงหลังเอามือออก (cleared) ก่อนถ่าย — นับถอยหลังบนจอ

// น้ำหนักบนถาดต้องเกินเท่านี้ (กรัม) ถึงจะถือว่ามีของวางอยู่
// ultrasonic บอกได้แค่ "มีอะไรบังอยู่" ซึ่งมือเปล่าก็เข้าเงื่อนไข — ตาชั่งเป็นตัวเดียว
// ที่ยืนยันได้ว่ามีของอยู่บนถาดจริง จึงใช้เป็นด่านสุดท้ายก่อนถ่าย
//
// ใช้ค่าสัมบูรณ์ ไม่ใช่ส่วนต่างจากตอนเข้าหน้ากล้อง เพราะถ้าคนปล่อยของลงเร็วกว่าที่
// ultrasonic จะเห็นมือ ค่าตั้งต้นจะถูกจับตอนของอยู่บนถาดแล้ว ส่วนต่างเป็น 0 →
// ปฏิเสธทั้งที่มีของจริง
// ถาดว่างอ่านได้ 1.4-1.7 กรัม (จาก log จริง) และนิ่งกว่า 1 กรัม 2 กรัมจึงเฉียดขอบบน
// ของค่าถาดว่างอยู่ — แลกมาเพื่อให้รับของเบา ๆ (ซองขนม/หลอด) ได้ ถ้าเจอเด้ง
// "ไม่เจอขยะ" ทั้งที่มีของ หรือเด้งเข้าโหมดถ่ายทั้งที่ถาดว่าง ให้ดันกลับเป็น 3
const MIN_ITEM_WEIGHT_G = 3

// เอามือออกแล้วแต่ถาดยังว่าง — ยังไม่ถือว่าจบ ให้เวลาคนวางของก่อนเท่านี้
// (ultrasonic ยิง cleared ทันทีที่มือพ้นระยะ ซึ่งมักเกิดก่อนคนวางของจริงด้วยซ้ำ
//  ถ้าตัดจบตรงนั้นเลย หน้าจอจะเด้งกลับหน้าแรกใส่คนที่กำลังจะวาง)
const NO_ITEM_GRACE_MS = 15000
const ITEM_POLL_MS     = 300     // ถี่แค่ไหนในการเช็คว่ามีของมาวางหรือยัง
const EMPTY_HOLD_MS      = 2600  // ค้างข้อความ "ไม่เจอขยะ" ก่อนกลับหน้าแรก

export default function CameraPage({ onResult, onEmpty }) {
  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const streamRef   = useRef(null)
  const sampleRef   = useRef(null)
  const lastFrame   = useRef(null)
  const capturedRef = useRef(false)   // กันถ่ายซ้ำ (ยิงครั้งเดียวต่อการเข้าหน้ากล้อง)
  const captureTimersRef = useRef([]) // timer ของการนับถอยหลัง (เก็บไว้ยกเลิกได้)
  const pendingCaptureRef = useRef(false) // cleared มาก่อนกล้องพร้อม → คิวไว้ถ่ายเมื่อพร้อม
  const handOutRef      = useRef(false)  // มือพ้นระยะแล้วหรือยัง (เข้าหน้านี้ตอน detected = ยัง)
  const waitPollRef     = useRef(null)   // ตัวเช็คว่ามีของมาวางหรือยัง ระหว่างรอ
  const waitDeadlineRef = useRef(null)   // หมดเวลารอ → ยอมแพ้ กลับหน้าแรก

  // phase: init | denied | unsupported | watching | scanning | capturing | processing
  const [phase, setPhase] = useState('init')
  const [countdown, setCountdown] = useState(0)   // วินาทีที่เหลือก่อนถ่าย (0 = ไม่นับ)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const CAMERA_ZOOM =0.5

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
          setPhase(p => {
            if (p !== 'scanning') sfx.click()   // chirp when first detected
            return 'scanning'
          })
        }
        // การถ่ายไม่ได้ทริกจาก "ภาพนิ่ง" อีกต่อไป — รอสัญญาณ cleared จากเซนเซอร์
        // (คนวางของแล้วเอามือออก) ดู sensor-driven capture effect ด้านล่าง
      }
      lastFrame.current = new Uint8ClampedArray(cur)
    }

    const warm = setTimeout(() => { pollId = setInterval(tick, POLL_INTERVAL) }, WARMUP_MS)
    return () => { clearTimeout(warm); clearInterval(pollId) }
  }, [phase])

  /* ---------------- sensor-driven capture (หน่วง 5 วิ) ----------------
     flow: มือเข้ามา (detected → เปิดไฟกล้อง + เข้าหน้านี้ ที่ App.jsx) → วางของ →
     เอามือออก (ultrasonic กลับมา >45cm → node #1 ส่ง "cleared") → นับถอยหลัง
     CAPTURE_DELAY_MS → ค่อยถ่าย (กันมือติดในเฟรม). ถ้ามือกลับเข้ามา (detected)
     ระหว่างนับ → ยกเลิก  */
  function cancelCountdown() {
    captureTimersRef.current.forEach(clearTimeout)
    captureTimersRef.current = []
    setCountdown(0)
  }

  // เริ่มนับถอยหลัง CAPTURE_DELAY_MS แล้วถ่าย (กันซ้ำ/กันเริ่มซ้อน)
  // ด่านน้ำหนัก — ultrasonic บอกได้แค่ "มีอะไรบังอยู่" ซึ่งมือเปล่าก็เข้าเงื่อนไข
  // ตาชั่งเป็นตัวเดียวที่ยืนยันได้ว่ามีของวางลงไปจริง
  // คืน true ถ้ายังไม่เคยได้ค่าน้ำหนัก (ตาชั่งหลุด/ยังไม่ส่งมา) — ไม่บล็อกการใช้งาน
  function hasRealItem() {
    const nowG = getSensor().lastWeight()
    if (nowG == null) return true
    return nowG > MIN_ITEM_WEIGHT_G
  }

  // จบรอบแบบไม่ถ่าย — ขึ้นข้อความบอกแล้วกลับหน้าแรกไปรอคำสั่งใหม่
  function abortEmpty() {
    capturedRef.current = true          // ปิดรอบนี้ กัน cleared ที่ตามมายิงซ้ำ
    cancelCountdown()
    setPhase('empty')
    // ใส่ใน captureTimersRef เพื่อให้ cleanup ตอน unmount เคลียร์ให้ด้วย
    captureTimersRef.current.push(setTimeout(() => onEmpty?.(), EMPTY_HOLD_MS))
  }

  function stopWaiting() {
    clearInterval(waitPollRef.current);     waitPollRef.current = null
    clearTimeout(waitDeadlineRef.current);  waitDeadlineRef.current = null
  }

  // ถาดยังว่าง — ยังไม่ตัดจบ รอให้คนวางของภายใน NO_ITEM_GRACE_MS ก่อน
  // เช็คด้วยการ poll แทนที่จะรอ event 'cleared' รอบใหม่ เพราะของอาจถูกวางลง
  // โดยมือไม่เข้าระยะ ultrasonic อีกเลย (หย่อนจากด้านบน) แล้วจะไม่มี event ตามมา
  function waitForItem() {
    if (waitPollRef.current) return          // รออยู่แล้ว ไม่ต้องเริ่มซ้อน
    cancelCountdown()
    setPhase('waiting')
    waitPollRef.current = setInterval(() => {
      // ต้องรอให้มือพ้นเฟรมก่อนด้วย ไม่งั้นนับถอยหลังทั้งที่มือยังบังของอยู่
      if (!capturedRef.current && handOutRef.current && hasRealItem()) {
        stopWaiting()
        startCountdown()
      }
    }, ITEM_POLL_MS)
    waitDeadlineRef.current = setTimeout(() => { stopWaiting(); abortEmpty() }, NO_ITEM_GRACE_MS)
  }

  function startCountdown() {
    if (capturedRef.current || captureTimersRef.current.length) return

    // เอามือออกแล้วแต่ถาดยังว่าง = ยังไม่ได้วางอะไร — ให้เวลาก่อน อย่าเพิ่งไล่กลับ
    if (!hasRealItem()) { waitForItem(); return }
    stopWaiting()

    const secs = Math.round(CAPTURE_DELAY_MS / 1000)
    setCountdown(secs)
    for (let i = 1; i < secs; i++) {
      captureTimersRef.current.push(setTimeout(() => { setCountdown(secs - i); sfx.click() }, i * 1000))
    }
    captureTimersRef.current.push(setTimeout(() => {
      captureTimersRef.current = []
      setCountdown(0)
      if (capturedRef.current) return
      // เช็คซ้ำก่อนลั่นชัตเตอร์ — ของอาจถูกหยิบกลับ/ตกหล่นระหว่างนับถอยหลัง 3 วิ
      // (node #1 ส่งน้ำหนักต่ออีก WEIGHT_TAIL_MS หลัง cleared ค่าตรงนี้จึงยังสด)
      if (!hasRealItem()) { waitForItem(); return }
      capturedRef.current = true
      autoCapture()
    }, CAPTURE_DELAY_MS))
  }

  useEffect(() => {
    const sensor = getSensor()
    const off = sensor.on((event) => {
      if (capturedRef.current) return
      // มือกลับเข้ามา → ยกเลิกนับถอยหลัง + ล้างคิว
      if (event === 'detected') {
        handOutRef.current = false
        pendingCaptureRef.current = false
        if (captureTimersRef.current.length) cancelCountdown()
        return
      }
      if (event !== 'cleared') return
      handOutRef.current = true
      if (phaseRef.current === 'watching' || phaseRef.current === 'scanning' || phaseRef.current === 'waiting') {
        startCountdown()                    // กล้องพร้อม → นับถอยหลังเลย
      } else {
        pendingCaptureRef.current = true     // เอามือออกก่อนกล้องเปิดเสร็จ → คิวไว้
      }
    })
    return () => { off(); cancelCountdown(); stopWaiting() }
  }, [])

  // กล้องพร้อม (watching) + มีคิวถ่ายค้าง (เอามือออกไปตอนกล้องยังโหลด) → เริ่มนับถอยหลัง
  useEffect(() => {
    if ((phase === 'watching' || phase === 'scanning') && pendingCaptureRef.current) {
      pendingCaptureRef.current = false
      startCountdown()
    }
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

    if (CAMERA_ZOOM > 1) {
      const cropW = w / CAMERA_ZOOM
      const cropH = h / CAMERA_ZOOM
      const sx = (w - cropW) / 2
      const sy = (h - cropH) / 2
      c.width = cropW; c.height = cropH
      c.getContext('2d').drawImage(v, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
    } else {
      c.width = w; c.height = h
      c.getContext('2d').drawImage(v, 0, 0, w, h)
    }
    const dataUrl = c.toDataURL('image/jpeg', 0.9)

    // brief shutter "flash" beat before processing screen
    await new Promise(r => setTimeout(r, 350))
    sfx.thinking()                                // 🤔 hmm sound

    setPhase('processing')
    const result = await classifyWaste(dataUrl)

    // เช็คเศษอาหารตามชนิดขยะ — ใช้ threshold ที่ตั้งไว้สำหรับ modelClass นั้น
    // (ดู FOOD_THRESHOLD_GRAMS ด้านบน). ชนิดที่ไม่อยู่ในตารางจะข้ามการเช็คน้ำหนัก
    const grams     = getSensor().lastWeight()
    const threshold = FOOD_THRESHOLD_GRAMS[result.modelClass]
    const hasFoodResidue =
      typeof threshold === 'number' &&
      typeof grams === 'number' &&
      grams > threshold

    onResult({ image: dataUrl, ...result, hasFoodResidue, weight: grams })
  }

  /* ---------------- right-column status copy ----------------
     `text`   — what shows in the bubble
     `speech` — what the mascot says (only for phases that have time to talk;
                quick phases like scanning/capturing just rely on sfx + visual)
  */
  const rightCopy = {
    init:        { mood: 'happy',  text: 'กำลังเปิดกล้องน้า...',  speech: '' },
    watching:    { mood: 'happy',  text: 'วางขยะแล้วเอามือออกน้า~', speech: 'วางขยะตรงหน้าน้องคาปิ แล้วเอามือออก เดี๋ยวถ่ายให้น้า' },
    scanning:    { mood: 'happy',  text: 'เห็นแล้ว ถือนิ่ง ๆ น้า!',  speech: '' },
    capturing:   { mood: 'starry', text: 'ถ่ายภาพแล้ว!',           speech: '' },
    processing:  { mood: 'starry', text: 'น้องคาปิกำลังคิด...',     speech: 'น้องคาปิกำลังคิดอยู่นะ รอแป๊บนึงน้า' },
    waiting:     { mood: 'happy',  text: 'วางขยะได้เลยน้า~',        speech: 'วางขยะลงตรงนี้ได้เลยน้า น้องคาปิรออยู่' },
    empty:       { mood: 'sad',    text: 'ยังไม่เจอขยะน้า~',        speech: 'อ้าว ยังไม่มีขยะวางเลยน้า เดี๋ยวน้องคาปิกลับไปรอที่หน้าแรกนะ' },
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
              style={CAMERA_ZOOM > 1 ? { transform: `scale(${CAMERA_ZOOM})`, transformOrigin: 'center center' } : undefined}
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

            {/* countdown ก่อนถ่าย (หลังเอามือออก) */}
            {countdown > 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/25 pointer-events-none">
                <div key={countdown} className="text-white text-[7rem] leading-none font-extrabold drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)] animate-pop">
                  {countdown}
                </div>
                <div className="bubble text-xs mt-3 whitespace-nowrap">เอามือออกแล้ว! ถ่ายในอีก {countdown} วิ 📸</div>
              </div>
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
              วางขยะแล้วเอามือออก น้องคาปิถ่ายให้เองน้า 💡
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
