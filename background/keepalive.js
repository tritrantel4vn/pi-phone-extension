const PI_PHONE_HEALTH_ALARM = 'pi-phone-connection-health'
const PI_PHONE_OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html')

async function hasOffscreenDocument() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) return false
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [PI_PHONE_OFFSCREEN_URL]
  }).catch(() => [])
  return contexts.length > 0
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WEB_RTC', 'AUDIO_PLAYBACK', 'LOCAL_STORAGE'],
      justification: 'Maintain and supervise the background WebRTC SIP connection'
    })
    return true
  } catch (error) {
    if (!error?.message?.includes('Only a single offscreen document may be created')) {
      console.warn('[pi-phone][keepalive] Unable to create offscreen document:', error)
    }
    return hasOffscreenDocument()
  }
}

async function syncStoredAccount() {
  const { selectedSipAccount, sendDTMF } = await chrome.storage.local.get([
    'selectedSipAccount',
    'sendDTMF'
  ])
  if (!selectedSipAccount) return
  await chrome.runtime.sendMessage({
    to: 'offscreen',
    action: 'INIT_SIP',
    payload: { sipAccount: selectedSipAccount, sendDTMF: Boolean(sendDTMF) }
  }).catch(() => {})
}

async function supervisePhoneConnection() {
  const existed = await hasOffscreenDocument()
  if (!(await ensureOffscreenDocument())) return
  if (!existed) await syncStoredAccount()
  await chrome.runtime.sendMessage({ to: 'offscreen', action: 'HEALTH_CHECK' }).catch(() => {})
}

function installHealthAlarm() {
  chrome.alarms.create(PI_PHONE_HEALTH_ALARM, { periodInMinutes: 1 })
  void supervisePhoneConnection()
}

chrome.runtime.onInstalled.addListener(installHealthAlarm)
chrome.runtime.onStartup.addListener(installHealthAlarm)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PI_PHONE_HEALTH_ALARM) void supervisePhoneConnection()
})

installHealthAlarm()
