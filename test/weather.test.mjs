import test from 'node:test'
import assert from 'node:assert/strict'
import { formatWeather } from '../src/tools/weather.mjs'

test('formatWeather renders a compact human line', () => {
  const s = formatWeather('Tel Aviv', { temperature_2m: 29, weather_code: 1, wind_speed_10m: 12 },
    { time: ['2026-07-14'], temperature_2m_max: [31], temperature_2m_min: [24] })
  assert.match(s, /Tel Aviv/)
  assert.match(s, /29/)
  assert.match(s, /31/)
  assert.match(s, /24/)
  assert.match(s, /mostly clear/)
})
