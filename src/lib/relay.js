/**
 * Relay control — fire-and-forget HTTP POST to the Python model server
 * (model_server.py) which controls 5 GPIO relays on the Pi:
 *
 *   wet         → GPIO 17 (pin 11)
 *   recyclable  → GPIO 27 (pin 13)
 *   hazardous   → GPIO 22 (pin 15)
 *   general     → GPIO 23 (pin 16)
 *   camera      → GPIO 24 (pin 18)   — auto-off after 5 min of inactivity
 *
 * The endpoint URL defaults to <model api host>/relay so it follows whatever
 * VITE_MODEL_API_URL is set to. Override with VITE_RELAY_API_URL if you want
 * to point the relay calls at a different server.
 *
 * All calls are no-fail (silent .catch) so the UI keeps working even when
 * the model/relay server isn't running (e.g. running `npm run dev` alone).
 */

const MODEL_API_URL = import.meta.env?.VITE_MODEL_API_URL || 'http://localhost:8000/classify'
const RELAY_API_URL =
  import.meta.env?.VITE_RELAY_API_URL ||
  MODEL_API_URL.replace(/\/classify\/?$/, '/relay')

function post(payload) {
  return fetch(RELAY_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(err => {
    // Server may be offline (dev without model server) — don't spam errors
    if (!post._warned) {
      console.warn('[relay] server unreachable at', RELAY_API_URL, '—', err?.message || err)
      post._warned = true
    }
  })
}

/** Turn on the relay that matches the classification result; turn off the others. */
export function relayForType(type) {
  return post({ event: 'classify', type })
}

/** Tell the server the camera is currently in use — keeps the camera light on, resets the 5-min idle timer. */
export function relayCameraActive() {
  return post({ event: 'camera_active' })
}

/** Force the camera light off now (don't wait for idle timeout). */
export function relayCameraOff() {
  return post({ event: 'camera_off' })
}

/** Turn off every relay. */
export function relayAllOff() {
  return post({ event: 'all_off' })
}
