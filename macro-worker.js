// Runs the keystroke macro off the main process so the cursor-tracking timer
// keeps the whip following the mouse while we type. Windows-only path.
const { parentPort } = require('worker_threads');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
const VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const PostMessageW = user32.func('int __stdcall PostMessageW(uintptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)');
const LoadKeyboardLayoutW = user32.func('uintptr_t __stdcall LoadKeyboardLayoutW(str pwszKLID, uint32_t Flags)');
const ActivateKeyboardLayout = user32.func('uintptr_t __stdcall ActivateKeyboardLayout(uintptr_t HKL, uint32_t Flags)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, void* lpdwProcessId)');
const GetKeyboardLayout = user32.func('uintptr_t __stdcall GetKeyboardLayout(uint32_t idThread)');

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_SHIFT   = 0x10;
const KEYUP      = 0x0002;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function releaseModifiers() {
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  keybd_event(VK_SHIFT, 0, KEYUP, 0);
  keybd_event(0x12, 0, KEYUP, 0);
}

function switchToEnglishIME() {
  const KL_ENGLISH = 0x00000409; // en-US
  try {
    if (GetForegroundWindow && GetWindowThreadProcessId && GetKeyboardLayout) {
      const hwnd = GetForegroundWindow();
      const tid = hwnd ? GetWindowThreadProcessId(hwnd, null) : 0;
      if (tid) {
        const hkl = GetKeyboardLayout(tid);
        const langId = Number(hkl & 0xffff);
        if (langId === 0x0409 || langId === 0x0809 || langId === 0x0c09 ||
            langId === 0x1009 || langId === 0x1409 || langId === 0x1809) {
          return; // already English — don't disturb an in-progress composition
        }
      }
    }
    if (GetForegroundWindow && PostMessageW) {
      const hwnd = GetForegroundWindow();
      if (hwnd) {
        PostMessageW(hwnd, 0x0050 /* WM_INPUTLANGCHANGEREQUEST */, 0x1, KL_ENGLISH);
      }
    }
    if (LoadKeyboardLayoutW && ActivateKeyboardLayout) {
      const hkl = LoadKeyboardLayoutW('00000409', 0x0001 /* KLF_ACTIVATE */);
      if (hkl) ActivateKeyboardLayout(hkl, 0x0000 /* KLF_REORDER */);
    }
  } catch (e) {
    console.warn('switchToEnglishIME failed:', e?.message || e);
  }
}

function runMacro(text, switchEnglish) {
  releaseModifiers();
  sleepSync(20);

  if (switchEnglish) {
    switchToEnglishIME();
    sleepSync(80);
  }

  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    sleepSync(10);
    keybd_event(vk, 0, KEYUP, 0);
    sleepSync(10);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(VK_SHIFT, 0, 0, 0);
    sleepSync(8);
    tapKey(vk);
    if (shiftState & 1) keybd_event(VK_SHIFT, 0, KEYUP, 0);
    sleepSync(8);
  };

  // Ctrl+C (interrupt)
  keybd_event(VK_CONTROL, 0, 0, 0);
  sleepSync(15);
  keybd_event(VK_C, 0, 0, 0);
  sleepSync(15);
  keybd_event(VK_C, 0, KEYUP, 0);
  sleepSync(15);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  sleepSync(60);

  for (const ch of text) tapChar(ch);
  sleepSync(40);
  keybd_event(VK_RETURN, 0, 0, 0);
  sleepSync(15);
  keybd_event(VK_RETURN, 0, KEYUP, 0);
  sleepSync(20);

  releaseModifiers();
}

parentPort.on('message', ({ text, switchEnglish }) => {
  try {
    runMacro(text, switchEnglish !== false);
  } catch (e) {
    console.warn('macro worker failed:', e?.message || e);
  }
});
