import './style.css'
import { supabase } from './supabase.js'

const MAX_READINGS = 50
let readings = []

document.querySelector('#app').innerHTML = `
  <main class="dashboard">
    <h1>Biometric Steering Wheel</h1>
    <p id="connection-status">Loading readings…</p>

    <section class="table-section">
      <h2>Live Test Readings</h2>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Value</th>
            <th>Device</th>
          </tr>
        </thead>
        <tbody id="readings-body"></tbody>
      </table>

      <p id="empty-message" hidden>No readings have been received yet.</p>
    </section>
  </main>
`

const statusElement = document.querySelector('#connection-status')
const readingsBody = document.querySelector('#readings-body')
const emptyMessage = document.querySelector('#empty-message')

function showStatus(message, isError = false) {
  statusElement.textContent = message
  statusElement.className = isError ? 'error' : 'success'
}

function renderReadings() {
  readingsBody.innerHTML = ''
  emptyMessage.hidden = readings.length > 0

  for (const reading of readings) {
    const row = document.createElement('tr')

    const idCell = document.createElement('td')
    idCell.textContent = reading.id

    const valueCell = document.createElement('td')
    valueCell.textContent = reading.value

    const deviceCell = document.createElement('td')
    deviceCell.textContent = reading.device_name

    row.append(idCell, valueCell, deviceCell)
    readingsBody.appendChild(row)
  }
}

async function loadReadings() {
  const { data, error } = await supabase
    .from('test_readings')
    .select('id, created_at, value, device_name')
    .order('created_at', { ascending: false })
    .limit(MAX_READINGS)

  if (error) {
    showStatus(`Could not load readings: ${error.message}`, true)
    return
  }

  readings = data
  renderReadings()
  showStatus('Connected — waiting for live readings.')
}

function startLiveUpdates() {
  supabase
    .channel('test-readings-live')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'test_readings',
      },
      (payload) => {
        readings = [
          payload.new,
          ...readings.filter((reading) => reading.id !== payload.new.id),
        ].slice(0, MAX_READINGS)

        renderReadings()
        showStatus('Live update received.')
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        showStatus('Connected — live updates enabled.')
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        showStatus(
          'Connected, but live updates could not start. Check Supabase Realtime settings.',
          true
        )
      }
    })
}

await loadReadings()
startLiveUpdates()