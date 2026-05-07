import { useEffect, useState } from 'react'
import Capybara from '../components/Capybara.jsx'
import { preloadClassifier } from '../lib/classifyWaste.js'
import { playVoice } from '../lib/sounds.js'

export default function ReadyPage() {
  // rotating fun-fact taglines
  const tips = [
    '🌱 แยกขยะวันละนิด โลกยิ้มได้ทุกวัน~',
    '♻️ ขวดน้ำ 1 ขวด รีไซเคิลได้ใหม่อีก!',
    '🍃 เศษผัก เศษอาหาร = ปุ๋ยให้ต้นไม้',
    '💧 ล้างก่อนทิ้ง รีไซเคิลได้ง่ายขึ้น',
    '🌍 ทุกคนช่วยกันได้ คาปิภูมิใจมาก!'
  ]
  const [tipIdx, setTipIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTipIdx(i => (i + 1) % tips.length), 3500)
    return () => clearInterval(id)
  }, [])

  // Start downloading the TFLite model in the background so it's ready by
  // the time the user reaches the camera page.
  useEffect(() => { preloadClassifier() }, [])

  // One-time welcome — spoken once when the page loads, then silent until
  // the sensor reports waste (handled by App.jsx) which navigates away.
  const WELCOME = 'สวัสดีจ้า~ เราคือน้องคาปิ ผู้ช่วยแยกขยะแสนน่ารัก ' +
                  'มาช่วยกันแยกขยะ เพื่อโลกที่ใสและสะอาดของเรากันเถอะน้า~ ' +
                  'วางขยะที่อยากแยกตรงด้านล่างได้เลยน้า!'

  useEffect(() => {
    const t = setTimeout(() => playVoice('welcome', WELCOME), 600)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="card w-full h-full max-h-[500px] p-5 overflow-hidden relative">

        {/* corner decorations */}
        <span className="absolute top-3 left-4 text-2xl animate-twinkle">🌿</span>
        <span className="absolute top-3 right-4 text-xl animate-sparkle" style={{ animationDelay: '.4s' }}>✨</span>
        <span className="absolute bottom-3 right-4 text-xl animate-sparkle" style={{ animationDelay: '.8s' }}>🌸</span>

        <div className="grid grid-cols-[440px_1fr] gap-4 h-full items-stretch">

          {/* LEFT: mascot scene with floating trash items */}
          <div className="relative flex flex-col items-center h-full">
            {/* floating recyclable hints around mascot */}
            <span className="absolute top-3 left-2 text-2xl animate-floaty z-10">🍎</span>
            <span className="absolute top-10 right-4 text-2xl animate-floaty z-10" style={{ animationDelay: '.6s' }}>🥤</span>
            <span className="absolute top-1/3 right-0 text-xl animate-floaty z-10" style={{ animationDelay: '1.1s' }}>📰</span>
            <span className="absolute top-1/2 left-0 text-xl animate-floaty z-10" style={{ animationDelay: '.4s' }}>🥫</span>

            {/* mascot */}
            <div className="flex-1 flex items-center justify-center min-h-0 z-10">
              <Capybara size={360} mood="happy" />
            </div>
          </div>

          {/* RIGHT: title + bubble + button */}
          <div className="flex flex-col items-center justify-center gap-3 px-2 h-full">

            {/* fancy title */}
            <div className="text-center relative">
              <span className="absolute -top-3 -left-4 text-xl animate-twinkle">✨</span>
              <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
                <span className="bg-gradient-to-b from-sky-500 to-sky-700 bg-clip-text text-transparent drop-shadow-sm">
                  น้องคาปิ
                </span>{' '}
                <span className="inline-block animate-wiggle">☁️</span>
              </h1>
              <p className="text-sky-600 font-semibold text-sm mt-0.5">
                ผู้ช่วยแยกขยะแสนน่ารัก 💚
              </p>
            </div>

            {/* speech bubble */}
            <div className="bubble-big animate-bob w-full" style={{ animationDuration: '2.6s' }}>
              สวัสดีจ้า~ มาช่วยกัน <br/>
              <span className="text-capy-500">แยกขยะ</span> เพื่อโลกของเรากัน! ☁️<br/>
              <span className="text-base">วางขยะลงตรงด้านล่างได้เลยน้า 👇</span>
            </div>

            {/* rotating tip */}
            <div className="text-xs font-semibold text-sky-700 bg-white/80 ring-2 ring-sky-100 rounded-full px-3 py-1 shadow-soft transition-all duration-500 min-h-[26px] flex items-center">
              {tips[tipIdx]}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

