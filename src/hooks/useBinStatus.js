import { useEffect, useRef, useState } from 'react'
import { getBinStatus } from '../lib/binStatus.js'

/**
 * Subscribe to bin-fill status from the WiFi bin-sensor ESP32.
 *
 *   const { full, connected } = useBinStatus(bin => showFullPopup(bin))
 *
 * `full`      — live map { wet, recyclable, hazardous, general } of booleans.
 * `connected` — WebSocket connection status (boolean).
 * `onBecameFull(bin)` — optional callback fired once each time a bin flips
 *                       empty→full (the "just became full" edge), so callers
 *                       can pop a notification without re-firing every render.
 */
export function useBinStatus(onBecameFull) {
  const [full, setFull]           = useState(() => getBinStatus().snapshot())
  const [connected, setConnected] = useState(() => getBinStatus().isConnected())
  const cbRef = useRef(onBecameFull)
  cbRef.current = onBecameFull

  useEffect(() => {
    const client = getBinStatus()
    setFull(client.snapshot())
    setConnected(client.isConnected())

    return client.on((snapshot, info) => {
      setFull(snapshot)
      if (info?.type === 'open')  setConnected(true)
      if (info?.type === 'close') setConnected(false)
      if (info?.type === 'update' && info.isFull) cbRef.current?.(info.bin)
    })
  }, [])

  return { full, connected }
}
