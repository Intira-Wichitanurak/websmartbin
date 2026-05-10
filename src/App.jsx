import { useEffect, useMemo, useRef, useState } from 'react'
import ReadyPage  from './pages/ReadyPage.jsx'
import CameraPage from './pages/CameraPage.jsx'
import ResultPage from './pages/ResultPage.jsx'
import { isMuted, setMuted, unlockAudio, sfx, stopSpeech } from './lib/sounds.js'
import { useSensor } from './hooks/useSensor.js'
import { getSensor } from './lib/sensor.js'

const STAGE_W = 1024
const STAGE_H = 600

export default function App() {
  const [page, setPage]     = useState('ready')
  const [result, setResult] = useState(null)

  // Scale the 1024x600 stage to fit the browser viewport while keeping aspect ratio.
  // Letterbox area shows the body's sky background, so it blends in invisibly.
  useEffect(() => {
    function fit() {
      const sx = window.innerWidth  / STAGE_W
      const sy = window.innerHeight / STAGE_H
      const scale = Math.min(sx, sy)
      document.documentElement.style.setProperty('--stage-scale', String(scale))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // Result page sets this to true only after its full speech/thank-you flow
  // has finished — until then we ignore "cleared" so picking up the trash
  // mid-sentence doesn't snap us back to home and cut off the audio.
  const resultDoneRef = useRef(false)

  function goHome()   { setResult(null); setPage('ready') }
  function goCamera() { setResult(null); setPage('camera') }
  function gotResult(r) {
    setResult(r)
    setPage('result')
    resultDoneRef.current = false
  }

  // Cancel any in-flight speech the moment we change pages, so the previous
  // page's voice never bleeds into the next page's audio.
  useEffect(() => { stopSpeech() }, [page])

  // Subscribe to ESP32 sensor events. Use a ref so the handler always sees
  // the current page (without re-subscribing on every page change).
  const pageRef = useRef(page)
  pageRef.current = page

  const sensorConnected = useSensor({
    detected: () => {
      // Trigger the flow only from the welcome screen
      if (pageRef.current === 'ready') goCamera()
    },
    cleared: () => {
      // Only auto-go-home from the result page once the result flow has
      // signalled it's safe to leave (verdict + thank-you spoken).
      if (pageRef.current === 'result' && resultDoneRef.current) goHome()
    }
  })

  // Dev shortcuts for testing without hardware: D = detected, C = cleared
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'd' || e.key === 'D') getSensor().dispatch('detected')
      if (e.key === 'c' || e.key === 'C') getSensor().dispatch('cleared')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <main className="stage flex flex-col">
      <SkyDecor />

      <header className="px-4 pt-3 flex justify-center relative z-10 shrink-0">
        <Stepper page={page} />
        <MuteToggle />
        <SensorBadge connected={sensorConnected} />
      </header>

      <section className="flex-1 min-h-0 relative z-10 px-4 py-2">
        {page === 'ready'  && <ReadyPage />}
        {page === 'camera' && <CameraPage onResult={gotResult} />}
        {page === 'result' && (
          <ResultPage
            result={result}
            onHome={goHome}
            onFlowDone={() => { resultDoneRef.current = true }}
          />
        )}
      </section>

      <footer className="text-center text-[11px] text-sky-700/80 py-1.5 relative z-10 shrink-0">
        ทำด้วย 💖 โดยน้องคาปิ
      </footer>
    </main>
  )
}

/* -------------------- sky decoration -------------------- */
function SkyDecor() {
  // CSS clouds — varying size, position, drift speed
  const clouds = [
    { w: 140, top: '6%',  left: '4%',   dur: 28, delay: 0 },
    { w: 100, top: '14%', left: '60%',  dur: 36, delay: -8 },
    { w: 180, top: '28%', left: '18%',  dur: 42, delay: -15 },
    { w:  90, top: '52%', left: '85%',  dur: 32, delay: -5 },
    { w: 130, top: '70%', left: '8%',   dur: 38, delay: -20 },
    { w: 110, top: '82%', left: '70%',  dur: 30, delay: -12 },
    { w:  80, top: '40%', left: '48%',  dur: 26, delay: -3 },
  ]

  // Floating particles — random positions/timings, memoized so they don't reshuffle
  const particles = useMemo(() => (
    Array.from({ length: 22 }).map((_, i) => ({
      key: i,
      left: Math.random() * 100,
      top:  60 + Math.random() * 40,            // start in lower half
      dur:  4 + Math.random() * 5,
      delay: -(Math.random() * 6),
      size: 4 + Math.random() * 6
    }))
  ), [])

  return (
    <>
      {/* sun with rotating rays */}
      <div className="sun-wrap" style={{ top: '5%', right: '5%' }}>
        <div className="sun-rays" />
        <div className="sun-disc" />
      </div>

      {/* fluffy CSS clouds drifting across the sky */}
      {clouds.map((c, i) => (
        <div
          key={i}
          className="cloud"
          style={{
            width: c.w,
            height: c.w * 0.36,
            top: c.top,
            left: c.left,
            animation: `cloudDrift ${c.dur}s ease-in-out ${c.delay}s infinite alternate`,
            opacity: 0.92
          }}
        />
      ))}

      {/* hot air balloons drifting */}
      <span className="deco animate-floaty" style={{ top: '32%', left: '4%', fontSize: 30 }}>🎈</span>
      <span className="deco animate-floaty" style={{ top: '58%', right: '6%', fontSize: 26, animationDelay: '1.5s' }}>🎈</span>

      {/* small decorations */}
      <span className="deco animate-twinkle" style={{ top: '20%', left: '40%', fontSize: 18 }}>✨</span>
      <span className="deco animate-twinkle" style={{ top: '78%', left: '50%', fontSize: 16, animationDelay: '.6s' }}>✨</span>
      <span className="deco animate-floaty"  style={{ top: '45%', left: '38%', fontSize: 22 }}>🐦</span>
      <span className="deco animate-floaty"  style={{ top: '72%', left: '92%', fontSize: 20, animationDelay: '1s' }}>🌈</span>

      {/* tiny floating particles */}
      {particles.map(p => (
        <span
          key={p.key}
          className="particle"
          style={{
            left: `${p.left}%`,
            top:  `${p.top}%`,
            width: p.size, height: p.size,
            animationDuration: `${p.dur}s`,
            animationDelay: `${p.delay}s`
          }}
        />
      ))}

      <style>{`
        @keyframes cloudDrift {
          0%   { transform: translateX(0px); }
          100% { transform: translateX(40px); }
        }
      `}</style>
    </>
  )
}

/* -------------------- sensor connection badge -------------------- */
function SensorBadge({ connected }) {
  return (
    <div
      title={connected ? 'เซนเซอร์เชื่อมต่อแล้ว' : 'เซนเซอร์ยังไม่ได้เชื่อมต่อ (กด D=วางขยะ, C=หยิบออก เพื่อทดสอบ)'}
      className={`absolute left-4 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-2 shadow-soft text-[11px] font-bold backdrop-blur
        ${connected
          ? 'bg-emerald-50 ring-emerald-200 text-emerald-700'
          : 'bg-rose-50 ring-rose-200 text-rose-700'}`}
    >
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-400'}`} />
      <span>{connected ? 'sensor' : 'no sensor'}</span>
    </div>
  )
}

/* -------------------- mute toggle -------------------- */
function MuteToggle() {
  const [muted, setLocal] = useState(() => isMuted())

  function toggle() {
    unlockAudio()           // ensure context exists
    const next = !muted
    setMuted(next)
    setLocal(next)
    if (!next) sfx.click()  // little chirp on un-mute
  }

  return (
    <button
      onClick={toggle}
      title={muted ? 'เปิดเสียง' : 'ปิดเสียง'}
      className="absolute right-4 top-3 w-9 h-9 rounded-full bg-white/90 ring-2 ring-white shadow-soft text-base hover:scale-110 active:scale-95 transition-transform"
    >
      {muted ? '🔇' : '🔊'}
    </button>
  )
}

function Stepper({ page }) {
  const steps = [
    { key: 'ready',  label: 'พร้อม',    icon: '🐹' },
    { key: 'camera', label: 'ถ่ายภาพ',  icon: '📷' },
    { key: 'result', label: 'ผลลัพธ์',  icon: '🌟' }
  ]
  const idx = steps.findIndex(s => s.key === page)
  return (
    <div className="flex items-center gap-1.5 bg-white/95 backdrop-blur ring-2 ring-white rounded-full px-3 py-1.5 shadow-[0_8px_20px_-6px_rgba(60,110,170,0.4)]">
      {steps.map((s, i) => {
        const active = i === idx
        const done   = i <= idx
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ring-2 transition-all
                ${done
                  ? 'bg-gradient-to-b from-sky-300 to-sky-500 text-white ring-white shadow-soft'
                  : 'bg-sky-50 text-sky-300 ring-sky-100'}
                ${active ? 'scale-110 animate-bob' : ''}`}
            >
              {s.icon}
            </span>
            <span className={`text-xs font-bold ${active ? 'text-sky-700' : 'text-sky-500/70'}`}>
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="text-sky-300">·</span>}
          </div>
        )
      })}
    </div>
  )
}
