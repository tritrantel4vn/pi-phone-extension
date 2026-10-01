const requestBtn = document.getElementById('requestBtn')
const titleText = document.getElementById('titleText')
const descText = document.getElementById('descText')
const statusText = document.getElementById('statusText')
const iconBox = document.getElementById('iconBox')

console.log('[permission.js] Script loaded, requestBtn:', requestBtn)

// Localize texts if locale is Vietnamese
if (chrome && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['locale'], (res) => {
    if (res?.locale === 'vi') {
      titleText.textContent = 'Yêu cầu quyền truy cập Micro'
      descText.textContent = 'PI PHONE cần quyền sử dụng micro để thực hiện và nhận cuộc gọi. Vui lòng nhấn "Cấp quyền Micro" bên dưới và chọn "Cho phép" (Allow) trên thông báo của trình duyệt.'
      requestBtn.textContent = 'Cấp quyền Micro'
    }
  })
}

async function requestMic() {
  console.log('[permission.js] requestMic button clicked')
  statusText.textContent = 'Requesting permission...'
  requestBtn.disabled = true
  requestBtn.style.opacity = '0.7'

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Stop stream immediately after acquiring permission
    stream.getTracks().forEach(t => t.stop())

    iconBox.className = 'icon-wrapper success'
    iconBox.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>'

    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['locale'], (res) => {
        if (res?.locale === 'vi') {
          titleText.textContent = 'Đã cấp quyền Micro thành công!'
          descText.textContent = 'Bạn có thể thực hiện cuộc gọi ngay bây giờ. Tab này sẽ tự đóng...'
        } else {
          titleText.textContent = 'Microphone Access Granted!'
          descText.textContent = 'You can make calls now. This tab will close automatically...'
        }
      })
    }

    requestBtn.style.display = 'none'
    statusText.textContent = ''

    // Notify extension UI that permission has been granted
    if (chrome && chrome.runtime) {
      chrome.runtime.sendMessage({ to: 'ui', action: 'MICROPHONE_GRANTED' })
    }

    setTimeout(() => {
      window.close()
    }, 1000)
  } catch (err) {
    console.error('[permission.js] getUserMedia error:', err)
    requestBtn.disabled = false
    requestBtn.style.opacity = '1'

    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['locale'], (res) => {
        if (res?.locale === 'vi') {
          statusText.textContent = 'Lỗi cấp quyền (' + (err.name || 'Error') + '). Vui lòng bấm vào biểu tượng Micro/Cài đặt trên thanh địa chỉ của Chrome để chuyển thành "Cho phép".'
        } else {
          statusText.textContent = 'Permission error (' + (err.name || 'Error') + '). Please click the microphone/lock icon in the Chrome address bar to allow microphone access.'
        }
      })
    }
  }
}

if (requestBtn) {
  requestBtn.addEventListener('click', requestMic)
}
