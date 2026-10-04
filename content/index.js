(() => {
  'use strict'

  const WEB_APP_SOURCE = 'PITEL_PBX'
  const PHONE_SOURCE = 'PI_PHONE'

  console.log('[pi-phone] Content script injected')

  function postToWebApp(action, data, requestId) {
    window.postMessage({ source: PHONE_SOURCE, action, data, requestId }, '*')
  }

  function announceReady() {
    postToWebApp('INIT_READY', {
      isInstalled: true,
      version: chrome.runtime.getManifest().version
    })
  }

  async function reportCurrentStatus(requestId) {
    announceReady()
    try {
      const state = await chrome.runtime.sendMessage({ to: 'offscreen', action: 'GET_STATE' })
      if (!state) return
      const account = state.currentAccount
      postToWebApp('STATUS_CHANGED', {
        status: state.isRegistered ? 'REGISTERED' : account ? 'UNREGISTERED' : 'DISCONNECTED',
        extension: account?.extension,
        health: state.health,
        checkedAt: Date.now()
      }, requestId)
      if (state.callStatus) {
        const stateMap = {
          connecting: 'CONNECTING',
          receiving: 'INCOMING',
          answered: 'CONNECTED'
        }
        const callState = stateMap[state.callStatus]
        if (callState) {
          postToWebApp('CALL_STATE_CHANGED', {
            state: callState,
            remoteNumber: state.remoteNumber || '',
            duration: state.callLog?.connectTimestamp
              ? Math.max(0, Math.round((Date.now() - state.callLog.connectTimestamp) / 1000))
              : undefined
          }, requestId)
        }
      }
    } catch (error) {
      console.warn('[pi-phone][content] Unable to read current phone state:', error)
    }
  }

  announceReady()
  setTimeout(announceReady, 500)

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== WEB_APP_SOURCE) return
    const { action, payload, requestId } = event.data
    console.log('[pi-phone][content] Received from WebApp:', action, payload)

    if (action === 'CHECK_STATUS') {
      await reportCurrentStatus(requestId)
      return
    }

    try {
      if (!chrome?.runtime?.id) {
        console.warn('[pi-phone][content] Extension context invalidated. Please reload the webpage.')
        postToWebApp('ERROR', {
          message: 'Extension context invalidated. Please reload the webpage.'
        }, requestId)
        return
      }
      const response = await chrome.runtime.sendMessage({
        to: 'background',
        source: WEB_APP_SOURCE,
        action,
        payload,
        requestId
      })
      if (response) postToWebApp(response.action || 'RESPONSE', response.data, requestId)
    } catch (error) {
      if (error?.message?.includes('Extension context invalidated')) {
        console.warn('[pi-phone][content] Extension context invalidated during message sending.')
      } else {
        console.error('[pi-phone][content] Error forwarding to background:', error)
      }
      postToWebApp('ERROR', { message: error?.message || String(error) }, requestId)
    }
  })

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.to !== 'webapp') return
    console.log('[pi-phone][content] Forwarding to WebApp:', message)
    postToWebApp(message.action, message.data, message.requestId)
    sendResponse({ received: true })
  })
})()
