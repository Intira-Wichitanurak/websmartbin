/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        capy: {
          50:  '#fff8ee',
          100: '#fdecd0',
          200: '#f6d49b',
          300: '#ecb56e',
          400: '#d99450',
          500: '#b16f33',
          600: '#7d4c25',
          brown: '#8a5a3b',
          cream: '#fff6e3'
        },
        leaf: {
          400: '#8bc28b',
          500: '#5fa46a',
          600: '#3f7d52'
        },
        bubble: {
          pink:   '#ffd1e0',
          peach:  '#ffd9c2',
          cream:  '#fff1d2',
          mint:   '#cfeedd',
          sky:    '#cfe6ff',
          lilac:  '#e3d4ff'
        }
      },
      fontFamily: {
        cute: ['"Mali"', '"Comic Sans MS"', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        cute: '0 10px 0 -2px rgba(176, 109, 51, 0.25), 0 18px 30px -8px rgba(176, 109, 51, 0.35)',
        soft: '0 6px 0 -2px rgba(0,0,0,0.08), 0 10px 24px -10px rgba(0,0,0,0.18)',
        pop:  '0 14px 30px -10px rgba(255, 154, 192, 0.55)'
      },
      keyframes: {
        /* base movements */
        bob:     { '0%,100%': { transform: 'translateY(0)' },         '50%': { transform: 'translateY(-6px)' } },
        wiggle:  { '0%,100%': { transform: 'rotate(-3deg)' },         '50%': { transform: 'rotate(3deg)' } },
        pop:     { '0%':      { transform: 'scale(.7)', opacity: 0 }, '100%': { transform: 'scale(1)', opacity: 1 } },
        sparkle: { '0%,100%': { opacity: .25, transform: 'scale(.9)' }, '50%': { opacity: 1, transform: 'scale(1.15)' } },
        jelly:   { '0%,100%': { transform: 'scale(1,1)' }, '30%': { transform: 'scale(1.08,.92)' }, '60%': { transform: 'scale(.96,1.04)' } },
        floaty:  { '0%,100%': { transform: 'translateY(0) translateX(0)' }, '50%': { transform: 'translateY(-14px) translateX(6px)' } },
        drift:   { '0%':      { transform: 'translateX(-10px)' }, '100%': { transform: 'translateX(10px)' } },
        twinkle: { '0%,100%': { transform: 'scale(1) rotate(0deg)', opacity: .6 }, '50%': { transform: 'scale(1.4) rotate(20deg)', opacity: 1 } },
        rainbow: { '0%,100%': { 'background-position': '0% 50%' }, '50%': { 'background-position': '100% 50%' } },
        confetti:{ '0%':      { transform: 'translateY(-20px) rotate(0deg)', opacity: 0 },
                   '15%':     { opacity: 1 },
                   '100%':    { transform: 'translateY(120vh) rotate(720deg)', opacity: 0 } },

        /* mascot pose animations */
        pounce: {
          '0%, 100%': { transform: 'translateY(0) scaleX(1) scaleY(1)' },
          '15%':      { transform: 'translateY(0) scaleX(1.12) scaleY(0.88)' },     /* squash */
          '45%':      { transform: 'translateY(-26px) scaleX(0.94) scaleY(1.06)' }, /* jump */
          '75%':      { transform: 'translateY(0) scaleX(1.06) scaleY(0.94)' }      /* land */
        },
        dance: {
          '0%, 100%': { transform: 'rotate(-5deg) translateX(-3px)' },
          '50%':      { transform: 'rotate(5deg) translateX(3px)' }
        },
        shiver: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%':      { transform: 'translateX(-2px) rotate(-1deg)' },
          '40%':      { transform: 'translateX(2px) rotate(1deg)' },
          '60%':      { transform: 'translateX(-1px) rotate(-.5deg)' },
          '80%':      { transform: 'translateX(1px) rotate(.5deg)' }
        },
        breathe: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%':      { transform: 'scale(1.04)' }
        },
        swayDown: {
          '0%, 100%': { transform: 'rotate(-3deg) translateY(0)' },
          '50%':      { transform: 'rotate(3deg) translateY(2px)' }
        },
        spinPop: {
          '0%':   { transform: 'scale(0.8) rotate(-12deg)' },
          '50%':  { transform: 'scale(1.1) rotate(8deg)' },
          '100%': { transform: 'scale(1) rotate(0deg)' }
        },
        blink: {
          '0%, 92%, 100%': { transform: 'scaleY(1)' },
          '95%':           { transform: 'scaleY(0.94)' }
        },

        /* overlay sprites */
        heartBurst: {
          '0%':   { transform: 'translate(0, 0) scale(0)',     opacity: 0 },
          '20%':  { transform: 'translate(0, -10px) scale(1)', opacity: 1 },
          '100%': { transform: 'translate(0, -55px) scale(0.6)', opacity: 0 }
        },
        starBurst: {
          '0%':   { transform: 'scale(0) rotate(0deg)',     opacity: 0 },
          '30%':  { transform: 'scale(1.3) rotate(120deg)', opacity: 1 },
          '100%': { transform: 'scale(0.6) rotate(360deg)', opacity: 0 }
        },
        tearDrop: {
          '0%':   { transform: 'translateY(0)  scale(.6)', opacity: 0 },
          '20%':  { transform: 'translateY(0)  scale(1)',  opacity: 1 },
          '100%': { transform: 'translateY(50px) scale(.7)', opacity: 0 }
        },
        zRise: {
          '0%':   { transform: 'translate(0, 0)    scale(.7)', opacity: 0 },
          '25%':  { transform: 'translate(0, -6px) scale(.9)', opacity: 1 },
          '100%': { transform: 'translate(14px, -38px) scale(1.4)', opacity: 0 }
        },
        questionPop: {
          '0%':   { transform: 'translate(0, 4px) scale(0)',   opacity: 0 },
          '20%':  { transform: 'translate(0, 0)   scale(1.3)', opacity: 1 },
          '60%':  { transform: 'translate(0, -4px) scale(1)',  opacity: 1 },
          '100%': { transform: 'translate(0, -16px) scale(.7)', opacity: 0 }
        },
        cloudShake: {
          '0%, 100%': { transform: 'translateX(-50%) translateY(0)' },
          '50%':      { transform: 'translateX(-50%) translateY(-3px)' }
        }
      },
      animation: {
        bob:     'bob 3s ease-in-out infinite',
        wiggle:  'wiggle 1.2s ease-in-out infinite',
        pop:     'pop .35s cubic-bezier(.34,1.56,.64,1)',
        sparkle: 'sparkle 1.6s ease-in-out infinite',
        jelly:   'jelly .55s ease-out',
        floaty:  'floaty 6s ease-in-out infinite',
        drift:   'drift 5s ease-in-out infinite alternate',
        twinkle: 'twinkle 2.2s ease-in-out infinite',
        rainbow: 'rainbow 6s ease infinite',
        confetti:'confetti 2.4s linear forwards',

        /* poses */
        pounce:  'pounce 1.4s ease-in-out infinite',
        dance:   'dance 1.1s ease-in-out infinite',
        shiver:  'shiver .35s ease-in-out infinite',
        breathe: 'breathe 3.4s ease-in-out infinite',
        swayDown:'swayDown 2.8s ease-in-out infinite',
        spinPop: 'spinPop .7s cubic-bezier(.34,1.56,.64,1)',
        blink:   'blink 4s ease-in-out infinite',

        /* overlay sprites */
        heartBurst:  'heartBurst 1.8s ease-out infinite',
        starBurst:   'starBurst 1.6s ease-out infinite',
        tearDrop:    'tearDrop 1.6s ease-in infinite',
        zRise:       'zRise 2.4s ease-in-out infinite',
        questionPop: 'questionPop 1.6s ease-out infinite',
        cloudShake:  'cloudShake 1.2s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
