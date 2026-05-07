import { useEffect, useRef, useState } from 'react'
import { getSensor } from '../lib/sensor.js'

/**
 * Subscribe to sensor events. Pass a handlers object:
 *
 *   useSensor({
 *     detected: () => goCamera(),
 *     cleared:  () => goHome()
 *   })
 *
 * Returns the live connection status (boolean).
 */
export function useSensor(handlers) {
  const [connected, setConnected] = useState(() => getSensor().isConnected())
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const sensor = getSensor()
    setConnected(sensor.isConnected())
    return sensor.on((event, data) => {
      if (event === 'open')  setConnected(true)
      if (event === 'close') setConnected(false)
      handlersRef.current?.[event]?.(data)
    })
  }, [])

  return connected
}
