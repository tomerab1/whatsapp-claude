// weather.mjs — Open-Meteo (free, no API key): geocode a place → current + today's range.
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain',
  65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers',
  82: 'violent showers', 95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'thunderstorm w/ hail',
}
const desc = (c) => WMO[c] ?? `code ${c}`

export function formatWeather(place, current, daily) {
  const today = `${Math.round(daily.temperature_2m_min[0])}–${Math.round(daily.temperature_2m_max[0])}°`
  return `${place}: ${Math.round(current.temperature_2m)}°C, ${desc(current.weather_code)}, wind ${Math.round(current.wind_speed_10m)} km/h (today ${today}).`
}

export async function getWeather(location) {
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`)).json()
  const g = geo?.results?.[0]
  if (!g) return `couldn't find "${location}"`
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
    `&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`
  const wx = await (await fetch(url)).json()
  return formatWeather(`${g.name}${g.country_code ? ', ' + g.country_code : ''}`, wx.current, wx.daily)
}

export const weatherTool = {
  name: 'get_weather',
  description: "Current weather + today's temperature range for a place (city/location name).",
  inputSchema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
  handler: async ({ location }) => ({ content: [{ type: 'text', text: await getWeather(location) }] }),
}
