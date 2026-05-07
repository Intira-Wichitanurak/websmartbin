import { useMemo } from 'react'
import Capybara from './Capybara.jsx'

export default function Modal({
  open,
  title,
  message,
  mood = 'thinking',
  mascotSrc,
  primaryLabel,                 // optional — omit for auto-dismissed popups
  onPrimary,
  secondaryLabel,
  onSecondary,
  tone = 'warn',
  confetti = false
}) {
  if (!open) return null

  const ring = {
    warn:    'ring-amber-300',
    danger:  'ring-rose-300',
    info:    'ring-sky-300',
    success: 'ring-emerald-300'
  }[tone]

  const titleColor = {
    warn:    'text-amber-700',
    danger:  'text-rose-700',
    info:    'text-sky-700',
    success: 'text-emerald-700'
  }[tone]

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center p-4
                 bg-capy-brown/40 backdrop-blur-sm overflow-hidden"
      role="dialog"
      aria-modal="true"
    >
      {confetti && <Confetti />}

      <div className={`w-full max-w-sm card ring-4 ${ring} animate-pop relative p-5`}>
        <div className="absolute -top-28 left-1/2 -translate-x-1/2">
          <Capybara size={200} mood={mood} src={mascotSrc} />
        </div>

        <div className="pt-20 text-center space-y-3">
          <h3 className={`text-xl font-bold ${titleColor}`}>{title}</h3>
          <p className="text-sky-700 leading-relaxed font-semibold">{message}</p>

          {(primaryLabel || secondaryLabel) && (
            <div className="flex flex-col sm:flex-row gap-2 pt-3 justify-center">
              {secondaryLabel && (
                <button onClick={onSecondary} className="btn-soft">
                  {secondaryLabel}
                </button>
              )}
              {primaryLabel && (
                <button onClick={onPrimary} className="btn-cute">
                  {primaryLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- confetti burst (pure CSS, no deps) ------------------------ */
function Confetti() {
  const pieces = useMemo(() => {
    const colors = ['#ff7aa8', '#ffd166', '#8bc28b', '#7fc4ff', '#c39bff', '#ffb084']
    const shapes = ['🎉', '⭐', '💖', '✨', '🌟', '🎊']
    return Array.from({ length: 26 }).map((_, i) => ({
      key: i,
      left: Math.random() * 100,
      delay: Math.random() * 1.2,
      dur:   1.6 + Math.random() * 1.4,
      size:  16 + Math.random() * 14,
      color: colors[i % colors.length],
      shape: Math.random() > .5 ? shapes[i % shapes.length] : null,
      tilt:  Math.random() * 360
    }))
  }, [])
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map(p => (
        <span
          key={p.key}
          className="absolute top-0 animate-confetti"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            fontSize: `${p.size}px`,
            color: p.color,
            transform: `rotate(${p.tilt}deg)`
          }}
        >
          {p.shape ?? '●'}
        </span>
      ))}
    </div>
  )
}
