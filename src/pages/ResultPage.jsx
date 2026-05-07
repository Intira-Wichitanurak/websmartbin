import { useEffect, useState } from 'react'
import Capybara from '../components/Capybara.jsx'
import Modal from '../components/Modal.jsx'
import { WASTE_TYPES } from '../lib/classifyWaste.js'
import { sfx, playVoice, stopSpeech } from '../lib/sounds.js'

export default function ResultPage({ result, onHome }) {
  const [popup, setPopup]       = useState(null)
  const [thankYou, setThankYou] = useState(false)

  /* Fully sequenced auto-flow — each step awaits the previous so nothing
     overlaps or feels rushed. If the component unmounts (e.g. sensor sent
     "cleared" early, or user pressed something), `cancelled` short-circuits
     the chain and we stop the running speech. */
  useEffect(() => {
    if (!result) return
    let cancelled = false
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const stop  = () => cancelled

    async function run() {
      if (result.blurry) {
        setPopup('blurry'); sfx.alert()
        await sleep(500); if (stop()) return
        await playVoice('popup_blurry',
          'ลองถ่ายใหม่อีกครั้งนะ ครั้งนี้น้องคาปิจะคัดแยกประเภทถูกอย่างแน่นอน')
        if (stop()) return
        await sleep(3000); if (stop()) return
        onHome()
        return
      }

      if (result.hasFoodResidue) {
        setPopup('food'); sfx.alert()
        await sleep(500); if (stop()) return
        await playVoice('popup_food',
          'กรุณาเขี่ยเศษอาหารทิ้งก่อน แล้วนำมาคัดแยกใหม่อีกครั้งน้า')
        if (stop()) return
        await sleep(3000); if (stop()) return
        onHome()
        return
      }

      // 1) success ding + announce verdict
      setPopup(null); sfx.success()
      const info = WASTE_TYPES[result.type] ?? WASTE_TYPES.general
      await sleep(700); if (stop()) return
      await playVoice(`result_${result.type}`,
        'น้องคาปิคิดว่าขยะนี้คือ ' + info.label + ' น้า~',
        { chirpAfter: true })
      if (stop()) return

      // 2) breathing room before thank-you
      await sleep(900); if (stop()) return

      // 3) show thank-you popup + melody, then read out the thank-you message
      setThankYou(true); sfx.thankyou()
      await sleep(700); if (stop()) return
      await playVoice('thankyou',
        'ขอบคุณที่ช่วยกันแยกขยะน้า~ โลกของเรายิ้มได้เพราะหนูเลย',
        { chirpAfter: true })
      if (stop()) return

      // 4) hold the popup briefly, then go home
      await sleep(3000); if (stop()) return
      onHome()
    }

    run().catch(err => console.warn('result flow error:', err))
    return () => { cancelled = true; stopSpeech() }
  }, [result])

  if (!result) return null

  const info = WASTE_TYPES[result.type] ?? WASTE_TYPES.general
  const pct  = Math.round((result.confidence ?? 0) * 100)
  const showCard = !popup

  return (
    <div className="h-full flex items-center justify-center">
      <div className="card w-full h-full max-h-[500px] p-4 overflow-hidden flex flex-col relative">

        {/* corner decorations */}
        <span className="absolute top-2 left-2 text-xl animate-twinkle z-10">🎉</span>
        <span className="absolute top-2 right-2 text-lg animate-sparkle z-10" style={{ animationDelay: '.5s' }}>🌟</span>
        <span className="absolute bottom-2 left-2 text-base animate-sparkle z-10" style={{ animationDelay: '.9s' }}>✨</span>

        {/* header — fully automatic flow, no manual buttons */}
        <div className="flex items-center justify-center mb-2 shrink-0 relative z-10">
          <h2 className="text-xl font-extrabold leading-tight">
            <span className="bg-gradient-to-b from-sky-500 to-sky-700 bg-clip-text text-transparent">
              ผลลัพธ์
            </span>{' '}
            <span className="animate-twinkle inline-block">🌟</span>
          </h2>
        </div>

        {/* main row: photo · verdict · big mascot+actions */}
        <div className="grid grid-cols-[1fr_1fr_360px] gap-3 flex-1 min-h-0">

          {/* photo with frame */}
          <div className="rounded-[1.25rem] overflow-hidden ring-4 ring-white shadow-[0_18px_30px_-10px_rgba(60,110,170,0.4)] bg-bubble-cream h-full relative">
            <img src={result.image} alt="ภาพขยะ" className="w-full h-full object-cover" />
            {/* sparkle on photo corner */}
            <span className="absolute top-2 right-2 text-lg animate-twinkle drop-shadow">✨</span>

            {/* DEBUG — model raw probabilities (delete this block once tuning is done) */}
            {result._debug && (
              <div className="absolute bottom-2 left-2 right-2 bg-black/60 text-white text-[10px] font-mono px-2 py-1 rounded-lg leading-tight">
                <div>idx <b>{result._debug.idx}</b> → {info.label}</div>
                <div>{result._debug.probs.map((p, i) => `${i}:${p.toFixed(2)}`).join(' ')}</div>
              </div>
            )}
          </div>

          {/* verdict card with shimmer + glow */}
          <div className={`relative rounded-[1.25rem] p-4 bg-gradient-to-br ${info.color} text-white shadow-pop ring-4 ring-white flex flex-col justify-between animate-pop overflow-hidden`}>
            {/* glossy top highlight */}
            <div className="absolute top-1 left-3 right-3 h-1/3 rounded-2xl bg-gradient-to-b from-white/40 to-transparent pointer-events-none" />
            {/* sparkles on the card */}
            <span className="absolute top-2 right-3 text-base animate-twinkle">✨</span>
            <span className="absolute bottom-12 right-2 text-sm animate-sparkle" style={{ animationDelay: '.5s' }}>⭐</span>

            <div className="relative">
              <p className="text-white/90 text-xs font-semibold tracking-wide">น้องคาปิคิดว่านี่คือ...</p>
              <p className="text-3xl font-extrabold mt-1 drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)] leading-tight">
                {info.emoji} {info.label}
              </p>
              <p className="mt-2 text-white/95 leading-snug text-xs font-semibold">
                {info.tip}
              </p>
            </div>

            <div className="relative mt-3">
              <div className="flex justify-between text-[11px] text-white/95 mb-1 font-bold">
                <span>ความมั่นใจ</span><span>{pct}%</span>
              </div>
              <div className="w-full h-3 rounded-full bg-black/15 overflow-hidden ring-2 ring-white/40 shadow-inner">
                <div className="h-full bg-gradient-to-r from-white/90 to-white rounded-full transition-all duration-700 shadow-[0_0_8px_rgba(255,255,255,0.7)]"
                     style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          {/* big mascot — no buttons; flow is fully automatic */}
          {showCard && (
            <div className="flex flex-col items-center h-full py-0 relative gap-1">
              <div className="bubble text-xs animate-bob shrink-0 z-10" style={{ animationDuration: '2.4s' }}>
                เก่งมากเลยน้า~ 💖
              </div>

              {/* floating celebration items around mascot */}
              <div className="flex-1 flex items-center justify-center min-h-0 relative w-full overflow-hidden">
                <span className="absolute top-2 left-2 text-lg animate-floaty z-10">🏆</span>
                <span className="absolute top-6 right-2 text-lg animate-floaty z-10" style={{ animationDelay: '.5s' }}>🎊</span>
                <span className="absolute bottom-6 left-1 text-sm animate-twinkle z-10" style={{ animationDelay: '.3s' }}>💫</span>
                <span className="absolute bottom-8 right-1 text-sm animate-twinkle z-10" style={{ animationDelay: '.7s' }}>⭐</span>
                <Capybara size={260} mood="cheer" src="/mascos6.png" />
              </div>

              <p className="text-center text-[11px] text-sky-600/70 font-semibold leading-snug shrink-0">
                หยิบขยะออกได้เลยน้า ระบบจะกลับหน้าแรกอัตโนมัติ ⏳
              </p>
            </div>
          )}
        </div>
      </div>

      {/* popups — no buttons, all auto-dismissed by the timeline above */}
      <Modal
        open={popup === 'blurry'}
        tone="warn"
        mood="sad"
        mascotSrc="/mascos5.png"
        title="ภาพไม่ชัดเจนเลยน้า..."
        message="ลองถ่ายใหม่อีกครั้งนะ ครั้งนี้น้องคาปิจะคัดแยกประเภทได้ถูกต้องแน่นอน 📷✨"
      />

      <Modal
        open={popup === 'food'}
        tone="warn"
        mood="thinking"
        mascotSrc="/mascos4.png"
        title="มีเศษอาหารติดอยู่น้า"
        message="กรุณาเขี่ยเศษอาหารทิ้งก่อน แล้วนำมาคัดแยกใหม่อีกครั้งน้า 🍃"
      />

      <Modal
        open={thankYou}
        tone="success"
        mood="love"
        title="ขอบคุณที่ช่วยกันแยกขยะ! 💖"
        message="โลกใบนี้ยิ้มได้เพราะหนูเลยน้า~ น้องคาปิภูมิใจมาก ๆ!"
        confetti
      />
    </div>
  )
}
