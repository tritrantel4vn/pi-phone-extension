// Offscreen Document WebRTC SIP controller for pi-phone
// Maintains 24/7 SIP connection and handles call operations even when extension UI is closed.

const VERSION = chrome.runtime?.getManifest?.()?.version || '1.0.0'
const SIP_USER_AGENT = `pi-phone ${VERSION}`

let pitelSDK = null
let currentAccount = null
let activeSipKey = null
let isInitializing = false

// Current call state maintained in offscreen
const callState = {
  isRegistered: false,
  callStatus: '', // '' | 'connecting' | 'receiving' | 'answered'
  callId: '',
  remoteNumber: '',
  callLog: null
}

function getCallId(callMeta = {}) {
  return typeof callMeta.callId === 'string' ? callMeta.callId.trim() : ''
}

function isSameCall(remoteNumber, callId) {
  if (callState.callId && callId) return callState.callId === callId
  return Boolean(remoteNumber) && callState.remoteNumber === remoteNumber
}

function logCallCallback(callback, remoteNumber, callId, result = 'processing') {
  console.log('[Offscreen][CallState]', {
    callback,
    result,
    remoteNumber,
    callId: callId || '(missing)',
    currentStatus: callState.callStatus,
    currentCallId: callState.callId || '(missing)',
    currentRemoteNumber: callState.remoteNumber
  })
}

// Audio management for ringtones and call feedback
class OffscreenAudioManager {
  constructor() {
    this.ringAudio = null
    this.ringbackAudio = null
  }

  playRingtone() {
    this.stopRingtone()
    this.stopRingback()
    try {
      this.ringAudio = new Audio(chrome.runtime.getURL('assets/audios/ringing.mp3'))
      this.ringAudio.loop = true
      this.ringAudio.play().catch((err) => {
        if (err?.name === 'NotAllowedError') {
          console.warn('[OffscreenAudio] playRingtone blocked by autoplay policy (no user gesture):', err.message)
        } else if (err?.name === 'AbortError') {
          // Play promise was interrupted by pause() - expected behavior when call answered/stopped
        } else {
          console.warn('[OffscreenAudio] playRingtone failed:', err?.name || err, err?.message || '')
        }
      })
    } catch (e) {
      console.warn('[OffscreenAudio] playRingtone error:', e)
    }
  }

  stopRingtone() {
    if (this.ringAudio) {
      this.ringAudio.pause()
      this.ringAudio.currentTime = 0
      this.ringAudio = null
    }
  }

  playRingback() {
    this.stopRingback()
    this.stopRingtone()
    try {
      this.ringbackAudio = new Audio(chrome.runtime.getURL('assets/audios/us-ringback.mp3'))
      this.ringbackAudio.loop = true
      this.ringbackAudio.play().catch((err) => {
        if (err?.name === 'NotAllowedError') {
          console.warn('[OffscreenAudio] playRingback blocked by autoplay policy (no user gesture):', err.message)
        } else if (err?.name === 'AbortError') {
          // Play promise was interrupted by pause() - expected behavior when call answered/stopped
        } else {
          console.warn('[OffscreenAudio] playRingback failed:', err?.name || err, err?.message || '')
        }
      })
    } catch (e) {
      console.warn('[OffscreenAudio] playRingback error:', e)
    }
  }

  stopRingback() {
    if (this.ringbackAudio) {
      this.ringbackAudio.pause()
      this.ringbackAudio.currentTime = 0
      this.ringbackAudio = null
    }
  }

  playHungup() {
    this.stopRingtone()
    this.stopRingback()
    try {
      const audio = new Audio(chrome.runtime.getURL('assets/audios/remote-party-hungup-tone.mp3'))
      audio.play().catch((err) => {
        if (err?.name !== 'NotAllowedError') {
          console.warn('[OffscreenAudio] playHungup failed:', err?.name || err, err?.message || '')
        }
      })
    } catch (e) { }
  }

  playFailed() {
    this.stopRingtone()
    this.stopRingback()
    try {
      const audio = new Audio(chrome.runtime.getURL('assets/audios/call-failed.mp3'))
      audio.play().catch((err) => {
        if (err?.name !== 'NotAllowedError') {
          console.warn('[OffscreenAudio] playFailed failed:', err?.name || err, err?.message || '')
        }
      })
    } catch (e) { }
  }

  stopAll() {
    this.stopRingtone()
    this.stopRingback()
  }
}

const audioManager = new OffscreenAudioManager()

// Broadcast state updates to Background Service Worker and Phone UI
function broadcastToExtension(action, payload = {}) {
  // 1. Notify background
  chrome.runtime.sendMessage({
    to: 'background',
    from: 'offscreen',
    action,
    payload
  }).catch(() => { })

  // 2. Notify Phone UI if currently open
  chrome.runtime.sendMessage({
    to: 'ui',
    from: 'offscreen',
    action,
    payload
  }).catch(() => { })
}

// Forward events to PBX Web App via background
function notifyWebApp(action, data = {}) {
  chrome.runtime.sendMessage({
    to: 'background',
    toWebApp: true,
    action,
    data
  }).catch(() => { })
}

async function cleanupPitelSDK() {
  if (pitelSDK) {
    try {
      if (pitelSDK.simpleUser) {
        await pitelSDK.simpleUser.disconnect().catch(() => { })
      } else {
        await pitelSDK.unregister().catch(() => { })
      }
    } catch (e) {
      console.warn('[Offscreen] Error cleaning up pitelSDK:', e)
    }
    pitelSDK = null
  }
  activeSipKey = null
  callState.isRegistered = false
  broadcastToExtension('SIP_STATE_CHANGED', { ...callState })
}

async function initPitelSDK(sipAccount, sendDTMF = false) {
  if (isInitializing) {
    console.log('[Offscreen] Init already in progress, skipping')
    return
  }

  if (!sipAccount || !sipAccount.extension || !sipAccount.domain) {
    console.log('[Offscreen] Invalid or empty SIP account, cleaning up')
    await cleanupPitelSDK()
    return
  }

  const currentKey = `${sipAccount.extension}@${sipAccount.domain}:${sipAccount.password || ''}`
  if (pitelSDK && activeSipKey === currentKey) {
    console.log('[Offscreen] SDK already initialized for account:', currentKey)
    return
  }

  isInitializing = true
  console.log('[Offscreen] Initializing PitelSDK for:', sipAccount.extension, sipAccount.domain)
  callState.isRegistered = false
  currentAccount = sipAccount

  try {
    await cleanupPitelSDK()

    if (typeof window.PitelSDK !== 'function') {
      console.error('[Offscreen] window.PitelSDK is not loaded')
      return
    }

    const sdkOptions = {
      enableWidget: false,
      sipOnly: true,
      sipDomain: sipAccount.domain,
      wsServer: sipAccount.wss,
      sipPassword: sipAccount.password,
      contactName: sipAccount.extension,
      userAgentString: SIP_USER_AGENT,
      dtmfUseRfc: sendDTMF,
    }

    const delegates = {
      onRegistered: () => {
        callState.isRegistered = true
        console.log('[Offscreen] SIP Register Success')
        broadcastToExtension('SIP_STATE_CHANGED', { ...callState })
        notifyWebApp('STATUS_CHANGED', {
          status: 'REGISTERED',
          extension: sipAccount.extension,
          name: sipAccount.name || sipAccount.extension
        })
      },
      onUnregistered: () => {
        callState.isRegistered = false
        console.log('[Offscreen] SIP Unregistered')
        broadcastToExtension('SIP_STATE_CHANGED', { ...callState })
        notifyWebApp('STATUS_CHANGED', {
          status: 'UNREGISTERED',
          extension: sipAccount.extension
        })
      },
      onCallCreated: (remoteNumber, callMeta = {}) => {
        const callId = getCallId(callMeta)
        const sameCall = isSameCall(remoteNumber, callId)

        if (sameCall && ['connecting', 'receiving', 'answered'].includes(callState.callStatus)) {
          logCallCallback('onCallCreated', remoteNumber, callId, 'ignored-duplicate-or-regression')
          return
        }

        logCallCallback('onCallCreated', remoteNumber, callId)
        callState.callStatus = 'connecting'
        callState.callId = callId
        callState.remoteNumber = remoteNumber
        callState.callLog = {
          callId,
          phoneNumber: remoteNumber,
          incoming: false,
          start: new Date().toISOString(),
          timestamp: Date.now()
        }
        audioManager.playRingback()
        broadcastToExtension('CALL_STATE_CHANGED', {
          callStatus: 'connecting',
          remoteNumber,
          callLog: callState.callLog
        })
        notifyWebApp('CALL_STATE_CHANGED', { state: 'CONNECTING', remoteNumber })
      },
      onCallAnswered: (remoteNumber, callMeta = {}) => {
        const callId = getCallId(callMeta)
        if (isSameCall(remoteNumber, callId) && callState.callStatus === 'answered') {
          logCallCallback('onCallAnswered', remoteNumber, callId, 'ignored-duplicate')
          return
        }

        logCallCallback('onCallAnswered', remoteNumber, callId)
        callState.callStatus = 'answered'
        callState.callId = callId || callState.callId
        callState.remoteNumber = remoteNumber
        audioManager.stopAll()
        if (!callState.callLog) {
          callState.callLog = {
            callId,
            phoneNumber: remoteNumber,
            incoming: false,
            start: new Date().toISOString(),
            timestamp: Date.now()
          }
        }
        if (callState.callLog) {
          callState.callLog.answered = true
          callState.callLog.answerAt = new Date().toISOString()
          callState.callLog.connectTimestamp = Date.now()
        }
        broadcastToExtension('CALL_STATE_CHANGED', {
          callStatus: 'answered',
          remoteNumber,
          callLog: callState.callLog
        })
        notifyWebApp('CALL_STATE_CHANGED', { state: 'CONNECTED', remoteNumber })
      },
      onCallReceived: (remoteNumber, callMeta = {}) => {
        const callId = getCallId(callMeta)
        const sameCall = isSameCall(remoteNumber, callId)

        if (sameCall && ['receiving', 'answered'].includes(callState.callStatus)) {
          logCallCallback('onCallReceived', remoteNumber, callId, 'ignored-duplicate-or-regression')
          return
        }

        logCallCallback('onCallReceived', remoteNumber, callId)
        callState.callStatus = 'receiving'
        callState.callId = callId || callState.callId
        callState.remoteNumber = remoteNumber
        callState.callLog = sameCall && callState.callLog
          ? {
            ...callState.callLog,
            callId: callId || callState.callLog.callId,
            incoming: true
          }
          : {
            callId,
            phoneNumber: remoteNumber,
            incoming: true,
            start: new Date().toISOString(),
            timestamp: Date.now()
          }

        audioManager.playRingtone()

        // Notify background to display notification & auto-open UI
        chrome.runtime.sendMessage({
          to: 'background',
          action: 'INCOMING_CALL_START',
          payload: { remoteNumber }
        }).catch(() => { })

        broadcastToExtension('CALL_STATE_CHANGED', {
          callStatus: 'receiving',
          remoteNumber,
          callLog: callState.callLog
        })
        notifyWebApp('CALL_STATE_CHANGED', { state: 'INCOMING', remoteNumber })
      },
      onCallHangup: (remoteNumber) => {
        const disconnectedRemoteNumber = remoteNumber || callState.remoteNumber
        logCallCallback('onCallHangup', disconnectedRemoteNumber, callState.callId)
        audioManager.playHungup()
        const duration = callState.callLog?.connectTimestamp
          ? Math.round((Date.now() - callState.callLog.connectTimestamp) / 1000)
          : 0

        callState.callStatus = ''
        callState.callId = ''
        callState.remoteNumber = ''

        chrome.runtime.sendMessage({ to: 'background', action: 'INCOMING_CALL_STOP' }).catch(() => { })
        broadcastToExtension('CALL_STATE_CHANGED', {
          callStatus: '',
          remoteNumber: disconnectedRemoteNumber,
          duration,
          callLog: callState.callLog
        })
        notifyWebApp('CALL_STATE_CHANGED', {
          state: 'DISCONNECTED',
          remoteNumber: disconnectedRemoteNumber,
          duration
        })
        callState.callLog = null
      }
    }

    pitelSDK = new window.PitelSDK('NO_NEED', 'NO_NEED', sipAccount.extension, delegates, sdkOptions)
    activeSipKey = currentKey
  } catch (err) {
    console.error('[Offscreen] Failed to instantiate PitelSDK:', err)
  } finally {
    isInitializing = false
  }
}

// Telephony actions
function makeCall(phoneNumber) {
  if (!phoneNumber) return
  callState.remoteNumber = phoneNumber
  callState.callStatus = 'connecting'
  try {
    pitelSDK?.call(phoneNumber, {})
  } catch (err) {
    console.error('[Offscreen] Error making call:', err)
    audioManager.playFailed()
  }
}

function acceptCall() {
  audioManager.stopAll()
  chrome.runtime.sendMessage({ to: 'background', action: 'INCOMING_CALL_STOP' }).catch(() => { })
  try {
    pitelSDK?.accept()
  } catch (err) {
    console.error('[Offscreen] Error accepting call:', err)
  }
}

function rejectCall() {
  audioManager.stopAll()
  chrome.runtime.sendMessage({ to: 'background', action: 'INCOMING_CALL_STOP' }).catch(() => { })
  try {
    pitelSDK?.reject()
  } catch (err) {
    console.error('[Offscreen] Error rejecting call:', err)
  }
  callState.callStatus = ''
  callState.callId = ''
  callState.remoteNumber = ''
}

function hangup() {
  audioManager.stopAll()
  chrome.runtime.sendMessage({ to: 'background', action: 'INCOMING_CALL_STOP' }).catch(() => { })
  try {
    pitelSDK?.hangup()
  } catch (err) {
    console.error('[Offscreen] Error hanging up call:', err)
  }
  callState.callStatus = ''
  callState.callId = ''
  callState.remoteNumber = ''
}

function hold(isHold) {
  if (callState.callStatus !== 'answered') {
    console.debug('[Offscreen] Ignored HOLD request: call is not answered')
    return
  }
  try {
    if (isHold) pitelSDK?.hold()
    else pitelSDK?.unhold()
    broadcastToExtension('CONTROL_STATE_CHANGED', { type: 'HOLD', isHold })
    notifyWebApp('CONTROL_STATE_CHANGED', { type: 'HOLD', isHold })
  } catch (err) {
    console.error('[Offscreen] Error holding/unholding call:', err)
  }
}

function mute(isMute) {
  if (callState.callStatus !== 'answered') {
    console.debug('[Offscreen] Ignored MUTE request: call is not answered')
    return
  }
  try {
    if (isMute) pitelSDK?.mute()
    else pitelSDK?.unmute()
    broadcastToExtension('CONTROL_STATE_CHANGED', { type: 'MUTE', isMute })
    notifyWebApp('CONTROL_STATE_CHANGED', { type: 'MUTE', isMute })
  } catch (err) {
    console.error('[Offscreen] Error muting/unmuting call:', err)
  }
}

function dtmf(digit) {
  if (callState.callStatus !== 'answered') {
    console.debug('[Offscreen] Ignored DTMF request: call is not answered')
    return
  }
  try {
    pitelSDK?.sendDTMF(digit)
    broadcastToExtension('CONTROL_STATE_CHANGED', { type: 'DTMF', digit })
    notifyWebApp('CONTROL_STATE_CHANGED', { type: 'DTMF', digit })
  } catch (err) {
    console.error('[Offscreen] Error sending DTMF:', err)
  }
}

function transfer(target) {
  if (callState.callStatus !== 'answered') {
    console.debug('[Offscreen] Ignored TRANSFER request: call is not answered')
    return
  }
  try {
    pitelSDK?.refer(target)
    broadcastToExtension('CONTROL_STATE_CHANGED', { type: 'TRANSFER', target })
    notifyWebApp('CONTROL_STATE_CHANGED', { type: 'TRANSFER', target })
  } catch (err) {
    console.error('[Offscreen] Error referring call:', err)
  }
}

// Runtime message dispatcher
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.to !== 'offscreen') return

  const { action, payload } = request
  console.log('[Offscreen] Received message:', action, payload)

  switch (action) {
    case 'INIT_SIP':
      initPitelSDK(payload?.sipAccount, payload?.sendDTMF)
      sendResponse({ status: 'INIT_STARTED' })
      break

    case 'CLEANUP_SIP':
      cleanupPitelSDK()
      sendResponse({ status: 'CLEANED_UP' })
      break

    case 'GET_STATE':
      sendResponse({
        isRegistered: callState.isRegistered,
        callStatus: callState.callStatus,
        remoteNumber: callState.remoteNumber,
        callLog: callState.callLog,
        currentAccount
      })
      break

    case 'MAKE_CALL':
      makeCall(payload?.phoneNumber)
      sendResponse({ status: 'CALL_INITIATED' })
      break

    case 'ACCEPT_CALL':
      acceptCall()
      sendResponse({ status: 'CALL_ACCEPTED' })
      break

    case 'REJECT_CALL':
      rejectCall()
      sendResponse({ status: 'CALL_REJECTED' })
      break

    case 'HANGUP_CALL':
      hangup()
      sendResponse({ status: 'CALL_HUNGUP' })
      break

    case 'HOLD_CALL':
      hold(payload?.isHold)
      sendResponse({ status: 'HOLD_UPDATED' })
      break

    case 'MUTE_CALL':
      mute(payload?.isMute)
      sendResponse({ status: 'MUTE_UPDATED' })
      break

    case 'SEND_DTMF':
      dtmf(payload?.digit)
      sendResponse({ status: 'DTMF_SENT' })
      break

    case 'TRANSFER_CALL':
      transfer(payload?.target)
      sendResponse({ status: 'TRANSFER_SENT' })
      break

    default:
      sendResponse({ status: 'UNKNOWN_ACTION' })
      break
  }
  return true
})

// Auto-sync active account from storage on offscreen start
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['selectedSipAccount', 'sendDTMF']).then((res) => {
    if (res?.selectedSipAccount) {
      initPitelSDK(res.selectedSipAccount, !!res.sendDTMF)
    }
  }).catch((err) => {
    console.warn('[Offscreen] Error reading initial storage:', err)
  })

  // Listen for storage changes in selected account or sendDTMF
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.selectedSipAccount) {
        const newAcc = changes.selectedSipAccount.newValue
        if (newAcc) {
          chrome.storage.local.get(['sendDTMF']).then(({ sendDTMF }) => {
            initPitelSDK(newAcc, !!sendDTMF)
          }).catch(() => { })
        } else {
          cleanupPitelSDK()
        }
      }
      if (changes.sendDTMF && currentAccount) {
        initPitelSDK(currentAccount, !!changes.sendDTMF.newValue)
      }
    }
  })
} else {
  console.log('[Offscreen] chrome.storage is not directly accessible in this offscreen context; awaiting messages from background/UI')
}
