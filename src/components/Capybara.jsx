import { useState } from 'react'

/**
 * Mascot powered by /public/mascos1.png — with SVG fallback if the image is missing.
 * Each mood drives a distinct body animation + a sequence of overlay sprites
 * so the mascot "feels" like it has a different reaction per situation.
 */
export default function Capybara({ size = 220, mood = 'happy', src, className = '' }) {
  const config = MOODS[mood] ?? MOODS.happy
  const [imgFailed, setImgFailed] = useState(false)
  const imageSrc = src ?? config.src ?? '/mascos1.png'

  return (
    <div
      className={`relative inline-block select-none ${className}`}
      style={{ width: size, height: size }}
      aria-label={`capybara mascot — ${mood}`}
    >
      {/* outer wrapper — pose animation (jump, dance, sway, etc) */}
      <div
        className={`w-full h-full ${config.outer ?? ''}`}
        style={{
          transformOrigin: '50% 90%',
          animationDuration: config.outerDur
        }}
      >
        {/* inner wrapper — static tilt/scale + filter, plus subtle blink */}
        <div
          className={`w-full h-full ${config.inner ?? 'animate-blink'}`}
          style={{
            transform: `rotate(${config.tilt ?? 0}deg) scale(${config.scale ?? 1})`,
            filter: config.filter,
            transformOrigin: '50% 80%',
            transition: 'transform .3s ease, filter .3s ease'
          }}
        >
          {!imgFailed ? (
            <img
              src={imageSrc}
              alt=""
              draggable="false"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-contain"
            />
          ) : (
            <CapybaraSVG mood={mood} />
          )}
        </div>
      </div>

      {/* overlays sit ABOVE the mascot, scaled to size */}
      <Overlays mood={mood} size={size} />
    </div>
  )
}

/* ---------------- mood configs ----------------------------------------- */
/* outer: dramatic pose animation                                          */
/* inner: subtle skin-of-the-mascot animation (usually blink)              */
/* tilt/scale/filter: static look-and-feel per mood                         */
const MOODS = {
  happy: {
    outer: 'animate-bob',  outerDur: '3s',
    inner: 'animate-blink',
    tilt: 0,    scale: 1,
    filter: 'drop-shadow(0 8px 10px rgba(0,0,0,0.12))'
  },
  thinking: {
    src: '/mascos2.png',
    outer: 'animate-dance', outerDur: '2.4s',
    inner: 'animate-blink',
    tilt: 0,    scale: 1,
    filter: 'drop-shadow(0 8px 10px rgba(0,0,0,0.12))'
  },
  cheer: {
    outer: 'animate-pounce', outerDur: '1.4s',
    inner: '',
    tilt: 0,    scale: 1.04,
    filter: 'saturate(1.25) brightness(1.06) drop-shadow(0 14px 14px rgba(255,180,80,0.4))'
  },
  sad: {
    outer: 'animate-swayDown', outerDur: '3.4s',
    inner: '',
    tilt: 0,    scale: 0.95,
    filter: 'saturate(.55) brightness(.92) drop-shadow(0 6px 8px rgba(0,0,0,0.18))'
  },
  sleepy: {
    outer: 'animate-breathe', outerDur: '3.6s',
    inner: '',
    tilt: 8,    scale: 1,
    filter: 'brightness(.9) blur(.3px) drop-shadow(0 6px 8px rgba(0,0,0,0.12))'
  },
  starry: {
    outer: 'animate-spinPop', outerDur: '.8s',
    inner: 'animate-bob',
    tilt: 0,    scale: 1.05,
    filter: 'saturate(1.3) brightness(1.1) drop-shadow(0 12px 14px rgba(255,210,90,0.45))'
  },
  love: {
    outer: 'animate-bob', outerDur: '2.4s',
    inner: 'animate-blink',
    tilt: -3,   scale: 1.03,
    filter: 'hue-rotate(-8deg) saturate(1.18) drop-shadow(0 12px 12px rgba(255,140,180,0.4))'
  }
}

/* ---------------- per-mood overlays ----------------------------------- */
function Overlays({ mood, size }) {
  const px = (n) => (size * n) / 100   // helper: percent of base size

  switch (mood) {

    /* HAPPY — soft sparkles around the head, gentle */
    case 'happy':
      return (
        <>
          <span className="absolute animate-twinkle" style={{ top: px(2),  left: px(8),  fontSize: px(8) }}>✨</span>
          <span className="absolute animate-twinkle" style={{ top: px(6),  right: px(10), fontSize: px(8), animationDelay: '.6s' }}>✨</span>
        </>
      )

    /* THINKING — cycling ? marks above head + a thought bubble */
    case 'thinking':
      return (
        <>
          <span className="absolute animate-questionPop" style={{ top: px(2),  right: px(14), fontSize: px(14), animationDelay: '0s'   }}>❓</span>
          <span className="absolute animate-questionPop" style={{ top: px(2),  right: px(8),  fontSize: px(11), animationDelay: '.5s'  }}>💭</span>
          <span className="absolute animate-questionPop" style={{ top: px(2),  right: px(18), fontSize: px(10), animationDelay: '1s'   }}>❔</span>
        </>
      )

    /* CHEER — fireworks of stars + sparkles bursting around the body */
    case 'cheer':
      return (
        <>
          <Burst cls="top-2  left-2"   delay="0s"   size={px(13)} char="✨" />
          <Burst cls="top-4  right-2"  delay=".25s" size={px(15)} char="⭐" />
          <Burst cls="top-1/2 -left-1"  delay=".5s"  size={px(12)} char="🌟" />
          <Burst cls="top-1/2 -right-1" delay=".75s" size={px(12)} char="✨" />
          <Burst cls="-top-2 left-1/2" delay=".4s"  size={px(14)} char="🎉" />
        </>
      )

    /* SAD — recurring tear drops + rain cloud above */
    case 'sad':
      return (
        <>
          <span
            className="absolute animate-cloudShake"
            style={{ top: -px(6), left: '50%', fontSize: px(20) }}
          >☁️</span>

          {/* tear from left eye */}
          <span
            className="absolute animate-tearDrop"
            style={{ top: '24%', left: '32%', fontSize: px(8) }}
          >💧</span>
          {/* tear from right eye, offset timing */}
          <span
            className="absolute animate-tearDrop"
            style={{ top: '24%', right: '32%', fontSize: px(8), animationDelay: '.7s' }}
          >💧</span>
        </>
      )

    /* SLEEPY — Z's drifting up and away, repeatedly */
    case 'sleepy':
      return (
        <>
          <span
            className="absolute animate-zRise font-bold text-capy-600"
            style={{ top: px(8), right: px(8), fontSize: px(14), animationDelay: '0s' }}
          >Z</span>
          <span
            className="absolute animate-zRise font-bold text-capy-600"
            style={{ top: px(8), right: px(8), fontSize: px(11), animationDelay: '.8s' }}
          >z</span>
          <span
            className="absolute animate-zRise font-bold text-capy-600"
            style={{ top: px(8), right: px(8), fontSize: px(9),  animationDelay: '1.6s' }}
          >z</span>
        </>
      )

    /* STARRY — stars erupt outward in a circle, with sparkles in the eyes */
    case 'starry':
      return (
        <>
          <Burst cls="-top-2 left-1/4"  delay="0s"   size={px(13)} char="⭐" />
          <Burst cls="-top-2 right-1/4" delay=".2s"  size={px(13)} char="✨" />
          <Burst cls="top-1/3 -left-2"  delay=".4s"  size={px(11)} char="⭐" />
          <Burst cls="top-1/3 -right-2" delay=".6s"  size={px(11)} char="✨" />
          <Burst cls="bottom-4 left-4"  delay=".3s"  size={px(10)} char="🌟" />
          <Burst cls="bottom-4 right-4" delay=".7s"  size={px(10)} char="🌟" />
          {/* tiny sparks at eye level */}
          <span className="absolute animate-twinkle" style={{ top: '20%', left: '32%',  fontSize: px(7) }}>✨</span>
          <span className="absolute animate-twinkle" style={{ top: '20%', right: '32%', fontSize: px(7), animationDelay: '.3s' }}>✨</span>
        </>
      )

    /* LOVE — hearts bursting upward from chest area */
    case 'love':
      return (
        <>
          <Heart cls="bottom-1/3 left-1/3"  delay="0s"   size={px(13)} char="💖" />
          <Heart cls="bottom-1/3 right-1/3" delay=".4s"  size={px(11)} char="💕" />
          <Heart cls="bottom-1/3 left-1/2"  delay=".8s"  size={px(15)} char="💗" />
          <Heart cls="bottom-1/3 right-1/4" delay="1.2s" size={px(10)} char="💞" />
          <Heart cls="bottom-1/3 left-1/4"  delay="1.6s" size={px(12)} char="💝" />
        </>
      )

    default:
      return null
  }
}

/* ---- overlay helpers ---- */

function Burst({ cls, delay, size, char }) {
  return (
    <span
      className={`absolute animate-starBurst ${cls}`}
      style={{ animationDelay: delay, fontSize: size }}
    >
      {char}
    </span>
  )
}

function Heart({ cls, delay, size, char }) {
  return (
    <span
      className={`absolute animate-heartBurst ${cls}`}
      style={{ animationDelay: delay, fontSize: size }}
    >
      {char}
    </span>
  )
}

/* ---------------- SVG fallback (used if the .png is missing) ---------- */
function CapybaraSVG({ mood = 'happy' }) {
  const eyes = {
    happy:    <g><ellipse cx="0" cy="0" rx="3.6" ry="4.4" fill="#2a1908" /><circle cx="-1.2" cy="-1.6" r="1.2" fill="#fff" /></g>,
    thinking: <ellipse cx="0" cy="0" rx="3.4" ry="4" fill="#2a1908" />,
    cheer:    <path d="M -5 1 Q 0 -6 5 1" stroke="#2a1908" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    sad:      <ellipse cx="0" cy="1" rx="3" ry="3.6" fill="#2a1908" />,
    sleepy:   <path d="M -5 0 Q 0 3 5 0" stroke="#3b2412" strokeWidth="2.6" fill="none" strokeLinecap="round" />,
    starry:   <path d="M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z" fill="#ffd166" />,
    love:     <path d="M0 4 C -7 -2, -7 -8, 0 -4 C 7 -8, 7 -2, 0 4 Z" fill="#ff7aa8" />
  }[mood] ?? null

  const mouth = {
    happy:    <path d="M -8 6 Q 0 13 8 6"  stroke="#3b2412" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    thinking: <path d="M -6 8 Q 0 6 6 8"   stroke="#3b2412" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    cheer:    <path d="M -10 4 Q 0 18 10 4 Q 0 11 -10 4 Z" fill="#7a3a1a" />,
    sad:      <path d="M -8 10 Q 0 4 8 10" stroke="#3b2412" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    sleepy:   <path d="M -5 8 Q 0 10 5 8"  stroke="#3b2412" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    starry:   <path d="M -8 5 Q 0 14 8 5"  stroke="#3b2412" strokeWidth="2.5" fill="none" strokeLinecap="round" />,
    love:     <path d="M -10 4 Q 0 16 10 4 Q 0 10 -10 4 Z" fill="#7a3a1a" />
  }[mood] ?? null

  return (
    <svg viewBox="-140 -130 280 270" width="100%" height="100%" aria-hidden="true">
      <ellipse cx="0" cy="108" rx="82" ry="10" fill="#000" opacity=".09" />
      <ellipse cx="0" cy="40" rx="92" ry="62" fill="#a86b34" />
      <ellipse cx="0" cy="48" rx="80" ry="52" fill="#c98a52" />
      <ellipse cx="0" cy="62" rx="36" ry="22" fill="#e8b079" opacity=".55" />
      <ellipse cx="-45" cy="100" rx="14" ry="8" fill="#7d4c25" />
      <ellipse cx="45"  cy="100" rx="14" ry="8" fill="#7d4c25" />
      <ellipse cx="0" cy="-40" rx="80" ry="62" fill="#a86b34" />
      <ellipse cx="0" cy="-32" rx="72" ry="54" fill="#c98a52" />
      <ellipse cx="-58" cy="-80" rx="14" ry="11" fill="#7d4c25" transform="rotate(-25 -58 -80)" />
      <ellipse cx="58"  cy="-80" rx="14" ry="11" fill="#7d4c25" transform="rotate(25 58 -80)" />
      <g transform="translate(-30 -42)">{eyes}</g>
      <g transform="translate(30 -42)">{eyes}</g>
      <ellipse cx="-46" cy="-12" rx="11" ry="6" fill="#ff8aa8" opacity=".55" />
      <ellipse cx="46"  cy="-12" rx="11" ry="6" fill="#ff8aa8" opacity=".55" />
      <ellipse cx="0" cy="-6" rx="24" ry="15" fill="#d99450" />
      <ellipse cx="0" cy="-12" rx="6" ry="4" fill="#3b2412" />
      <g>{mouth}</g>
      <g transform="translate(0 -100)">
        <circle r="14" fill="#ff9b3d" />
        <ellipse cx="-4" cy="-3" rx="3" ry="2" fill="#ffb874" opacity=".7" />
        <path d="M -4 -12 Q 0 -18 6 -14 Q 2 -10 -4 -12 Z" fill="#5fa46a" />
      </g>
    </svg>
  )
}
