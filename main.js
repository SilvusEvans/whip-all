const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let koffi;
let keybd_event;
let GetForegroundWindow;
let GetWindowThreadProcessId, OpenProcess, GetClassNameW, GetKeyboardLayout;
let GetWindowTextW, QueryFullProcessImageNameW, CloseHandle;
let SetForegroundWindow;
let SetWindowsHookExW, CallNextHookEx, UnhookWindowsHookEx, GetAsyncKeyState;
let kernel32;
if (process.platform === 'win32') {
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
    GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, void* lpdwProcessId)');
    GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, void* lpClassName, int nMaxCount)');
    GetKeyboardLayout = user32.func('uintptr_t __stdcall GetKeyboardLayout(uint32_t idThread)');
    GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, void* lpString, int nMaxCount)');
    OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
    QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(uintptr_t hProcess, uint32_t dwFlags, void* lpExeName, void* lpdwSize)');
    CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr_t hObject)');
    SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(uintptr_t hWnd)');
    SetWindowsHookExW = user32.func('uintptr_t __stdcall SetWindowsHookExW(int idHook, void* lpfn, uintptr_t hmod, uint32_t dwThreadId)');
    CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(uintptr_t hhk, int nCode, uintptr_t wParam, void* lParam)');
    UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(uintptr_t hhk)');
    GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay, settingsWin;
let overlayReady = false;
let spawnQueued = false;
let lastUserHwnd = 0; // foreground window before the overlay took over

// ── Crack overlay session state ─────────────────────────────────────────────
// The overlay is a fully transparent, click-through window. Because it no longer
// paints an opaque fill, it cannot receive DOM mouse events, so we feed it the
// cursor position from the main process. The lash is dropped via Ctrl+Q or the
// tray icon, not by clicking the screen.
let cursorTimer = null;        // lightweight cursor-poll timer
let overlayOffset = { x: 0, y: 0 }; // overlay window's screen origin (for cursor mapping)

// Keyboard hook for Ctrl+Q (Windows only), installed for the app's whole
// lifetime: while the lash is on screen Ctrl+Q drops it; otherwise
// Ctrl+Q quits the app. Both cases consume the key so it never leaks into
// the foreground application.
let kbHookHandle = 0;        // WH_KEYBOARD_LL hook handle (0 = not installed)
let kbHookCbRef = null;       // keeps the registered JS callback alive
const VK_Q = 0x51;
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;

// ── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(os.homedir(), '.whipall.json');
const DEFAULT_SETTINGS = {
  language: 'en',            // UI language: 'en' | 'zh' | 'zh-TW' | 'ja'
  theme: 'dark',             // UI theme: 'dark' | 'light'
  themeColor: '#6750a4',     // accent color (settings + lash)
  autoSwitchEnglish: true,   // switch IME to English before cracking
  showStatusBadge: true,     // show live foreground status badge above the lash
  statusPollMs: 300,         // how often to poll foreground state (ms)
  phrases: [
    'FASTER',
    'GO FASTER',
    'Speed it up',
    'Work FASTER',
    'Hurry up',
    'Move it',
    'Pick up the pace',
    'No slacking',
    'Get moving',
    'Step on it',
  ],
};
let settings = { ...DEFAULT_SETTINGS };

// UI strings, keyed by language.
const I18N = {
  en:    { settings: 'Settings', quit: 'Quit', tooltip: 'Whip-All - click to crack', title: 'Whip-All Settings' },
  zh:    { settings: '设置', quit: '退出', tooltip: 'Whip-All - 点击挥鞭', title: 'Whip-All 设置' },
  'zh-TW': { settings: '設定', quit: '退出', tooltip: 'Whip-All - 點擊揮鞭', title: 'Whip-All 設定' },
  ja:    { settings: '設定', quit: '終了', tooltip: 'Whip-All - クリックで煽る', title: 'Whip-All 設定' },
};
function t(key) {
  const lang = I18N[settings.language] ? settings.language : 'en';
  return I18N[lang][key];
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      settings = { ...DEFAULT_SETTINGS, ...raw };
      if (!Array.isArray(settings.phrases) || settings.phrases.length === 0) {
        settings.phrases = DEFAULT_SETTINGS.phrases;
      }
    }
  } catch (e) {
    console.warn('loadSettings failed:', e?.message || e);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.warn('saveSettings failed:', e?.message || e);
  }
}

const VK_CONTROL = 0x11;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

/** Blocking sleep. Used by the Alt+Tab fallback in refocusPreviousApp; the
 *  keystroke macro itself runs in macro-worker.js so the main loop stays free
 *  to keep feeding cursor positions to the whip while it types. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    // Fallback: busy wait if SharedArrayBuffer/Atomics is unavailable.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/** Restore focus to the app the user was in before the overlay appeared.
 *
 *  NOTE: this used to synthesise Alt+Tab, which is unreliable — the system can
 *  swallow the Alt key-up, leaving Alt stuck down. That made *the user's own
 *  later typing* register as Alt+key and emit garbage (e.g. "+m").
 *  On Windows we now remember the real foreground HWND and restore it directly. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      // Preferred: restore the exact window the user came from.
      if (lastUserHwnd && SetForegroundWindow) {
        SetForegroundWindow(lastUserHwnd);
        return;
      }
      // Fallback: Alt+Tab, but with delays so the key-ups are not swallowed.
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      sleepSync(30);
      keybd_event(VK_TAB, 0, 0, 0);
      sleepSync(30);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      sleepSync(30);
      keybd_event(VK_MENU, 0, KEYUP, 0);
      sleepSync(30);
      // Safety net: make sure Alt really got released.
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

// ── Lash overlay session: cursor feed ───────────────────────────────────────
// The overlay is transparent & click-through, so it can't read the mouse itself.
// The main process polls the cursor and feeds it to the lash so it stays glued
// to the pointer. Dropping the lash: Ctrl+Q (keyboard hook) or the tray icon.

function getCursorNow() {
  try {
    return screen.getCursorScreenPoint();
  } catch (e) {
    return null;
  }
}

// Low-level keyboard hook for Ctrl+Q, installed once at startup. While the
// lash overlay is visible Ctrl+Q drops the lash; otherwise it quits the app.
// Both cases consume the key so it never leaks into the foreground app.
function installKeyboardHook() {
  if (process.platform !== 'win32' || !SetWindowsHookExW || kbHookHandle) return;
  try {
    const CB = koffi.proto('int __stdcall (int, uintptr_t, void *)');
    kbHookCbRef = (nCode, wParam, kbPtr) => {
      try {
        // koffi does not auto-decode LPARAM; vkCode is the first uint32 and
        // flags the third in KBDLLHOOKSTRUCT. Skip injected events (LLKHF_INJECTED):
        // our own macro types phrases that may contain "Q", and a
        // user-held Ctrl at that moment would otherwise look like Ctrl+Q and quit.
        if (nCode >= 0 && kbPtr) {
          const flags = koffi.decode(kbPtr, 'uint32_t', 2);
          if (flags & 0x10) return CallNextHookEx(kbHookHandle, nCode, wParam, kbPtr);
        }
        const vk = (nCode >= 0 && kbPtr) ? koffi.decode(kbPtr, 'uint32_t') : -1;
        if (vk === VK_Q && nCode >= 0 && wParam === WM_KEYDOWN) {
          // Only fire when Ctrl is actually held (check live key state).
          const ctrlDown = GetAsyncKeyState ? (GetAsyncKeyState(VK_CONTROL) & 0x8000) : 0;
          if (ctrlDown) {
            if (overlay && overlay.isVisible() && !overlay.isDestroyed()) {
              // Lash on screen: Ctrl+Q drops it. Overlay ignores this if it is
              // already dropping, so a repeated Ctrl+Q is harmless.
              overlay.webContents.send('cursor-down');
            } else {
              // No lash: Ctrl+Q quits the app.
              app.quit();
            }
            return 1; // consume: Ctrl+Q never reaches the foreground app
          }
        }
      } catch (e) { /* never let a hook error break the desktop */ }
      return CallNextHookEx(kbHookHandle, nCode, wParam, kbPtr);
    };
    const ptr = koffi.register(kbHookCbRef, koffi.pointer(CB));
    kbHookHandle = SetWindowsHookExW(WH_KEYBOARD_LL, ptr, 0, 0);
    if (!kbHookHandle) {
      console.warn('installKeyboardHook: SetWindowsHookExW returned 0');
      try { koffi.unregister(ptr); } catch (e) {}
      kbHookCbRef = null;
    }
  } catch (e) {
    console.warn('installKeyboardHook failed (Ctrl+Q-to-drop unavailable):', e?.message || e);
    kbHookHandle = 0;
    kbHookCbRef = null;
  }
}

function uninstallKeyboardHook() {
  if (kbHookHandle && UnhookWindowsHookEx) {
    try { UnhookWindowsHookEx(kbHookHandle); } catch (e) {}
  }
  if (kbHookCbRef) {
    try { koffi.unregister(kbHookCbRef); } catch (e) {}
  }
  kbHookHandle = 0;
  kbHookCbRef = null;
}

// Poll the cursor from the main process and forward it to the overlay. This is
// safe (no system hook) and keeps the lash handle glued to the pointer.
function startCursorTracking() {
  stopCursorTracking();
  const tick = () => {
    if (overlay && overlay.isVisible() && !overlay.isDestroyed() && overlayReady) {
      const p = getCursorNow();
      if (p) overlay.webContents.send('cursor', p.x - overlayOffset.x, p.y - overlayOffset.y);
      cursorTimer = setTimeout(tick, 16);
    } else {
      cursorTimer = null;
    }
  };
  tick();
}

function stopCursorTracking() {
  if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
}

function beginLashSession() {
  // Send the current cursor position immediately so the lash spawns under it.
  const p = getCursorNow();
  if (p) overlay.webContents.send('cursor', p.x - overlayOffset.x, p.y - overlayOffset.y);
  startCursorTracking();
}

function endLashSession() {
  stopCursorTracking();
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('whipall: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'whipall-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Click-through: the window beneath keeps receiving mouse/keyboard input, and
  // (because it's now fully transparent) the Desktop Window Manager no longer
  // treats the foreground app as occluded — so it keeps repainting live.
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlayOffset = { x: bounds.x, y: bounds.y };
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      beginLashSession();
      overlay.webContents.send('spawn-lash');
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    endLashSession();
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-lash');
    return;
  }
  // Remember the window the user was actually working in, so we can restore
  // focus to it directly instead of faking Alt+Tab (which can stick Alt).
  // Only capture it when it is not our own settings window.
  if (GetForegroundWindow) {
    const hwnd = GetForegroundWindow();
    if (hwnd && !(settingsWin && hwnd === settingsWin.getNativeWindowHandle?.().readBigUInt64LE?.(0))) {
      // Accept any real foreground window; the settings window is excluded below.
      lastUserHwnd = hwnd;
    }
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    beginLashSession();        // installs hook + sends cursor *before* spawn
    overlay.webContents.send('spawn-lash');
    refocusPreviousApp();
  } else {
    spawnQueued = true;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('lash-crack', () => {
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) { overlay.hide(); endLashSession(); } });
ipcMain.handle('get-foreground-state', () => probeForegroundState());

// ── Settings window + IPC ───────────────────────────────────────────────────
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (e, patch) => {
  try {
    settings = { ...settings, ...(patch || {}) };
    if (!Array.isArray(settings.phrases) || settings.phrases.length === 0) {
      settings.phrases = DEFAULT_SETTINGS.phrases;
    }
    saveSettings();
    // Refresh tray menu/tooltip immediately so language changes apply at once.
    if (patch && (patch.language || patch.theme)) buildTrayMenu();
    return { ok: true, settings };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

function openSettings() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    title: t('title'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

/** Probe the current foreground window + input method state.
 *  Returns an object the overlay can render as a live foreground-status line. */
// Reused buffers to avoid per-poll allocation (polled every ~300ms).
const _titleBuf = Buffer.alloc(1024);
const _classBuf = Buffer.alloc(512);
const _pidBuf = Buffer.alloc(4);
const _nameBuf = Buffer.alloc(1024);
const _sizeBuf = Buffer.alloc(4);

function probeForegroundState() {
  const state = { app: '', title: '', className: '', procName: '', ime: 'en', langId: 0 };
  if (process.platform !== 'win32') return state;

  try {
    if (GetForegroundWindow) {
      const hwnd = GetForegroundWindow();
      if (hwnd) {
        // Window title
        if (GetWindowTextW) {
          _titleBuf.fill(0);
          GetWindowTextW(hwnd, _titleBuf, 512);
          state.title = _titleBuf.toString('utf16le').replace(/\0.*$/, '');
        }
        // Window class name
        if (GetClassNameW) {
          _classBuf.fill(0);
          GetClassNameW(hwnd, _classBuf, 256);
          state.className = _classBuf.toString('utf16le').replace(/\0.*$/, '');
        }
        // Process name (from PID -> image path)
        _pidBuf.fill(0);
        if (GetWindowThreadProcessId) {
          GetWindowThreadProcessId(hwnd, _pidBuf);
        }
        const pid = _pidBuf.readUInt32LE(0);
        if (pid && OpenProcess && QueryFullProcessImageNameW && CloseHandle) {
          const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
          const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
          if (h) {
            try {
              _nameBuf.fill(0);
              _sizeBuf.writeUInt32LE(1024, 0);
              if (QueryFullProcessImageNameW(h, 0, _nameBuf, _sizeBuf)) {
                const full = _nameBuf.toString('utf16le').replace(/\0.*$/, '');
                state.procName = full.split(/[\\/]/).pop() || full;
              }
            } finally {
              CloseHandle(h);
            }
          }
        }
        // Keyboard layout for the foreground thread
        const tid = GetWindowThreadProcessId ? GetWindowThreadProcessId(hwnd, null) : 0;
        if (tid && GetKeyboardLayout) {
          const hkl = GetKeyboardLayout(tid);
          state.langId = Number(hkl & 0xffff);
          state.ime = state.langId === 0x0409 ? 'en' : (state.langId === 0x0804 ? 'zh' : ('0x' + state.langId.toString(16)));
        }
        state.app = state.procName || state.title || state.className;
      }
    }
  } catch (e) {
    console.warn('probeForegroundState failed:', e?.message || e);
  }
  return state;
}

// ── Macro: immediate Ctrl+C, type a phrase, Enter ────────────────────
// The keystrokes are executed by macro-worker.js in a worker thread so the
// main process (cursor polling / whip animation) never blocks on sleepSync.
let macroWorker = null;
function getMacroWorker() {
  if (!macroWorker) {
    macroWorker = new Worker(path.join(__dirname, 'macro-worker.js'));
    macroWorker.on('error', err => {
      console.warn('macro worker error:', err?.message || err);
      macroWorker = null;
    });
  }
  return macroWorker;
}

function sendMacro() {
  // Pick a random phrase from the configured list and type it out
  const phrases = settings.phrases || DEFAULT_SETTINGS.phrases;
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];

  if (process.platform === 'win32') {
    getMacroWorker().postMessage({ text: chosen, switchEnglish: settings.autoSwitchEnglish !== false });
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen);
  } else if (process.platform === 'linux') {
    sendMacroLinux(chosen);
  }
}

function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const interruptScript = [
    'tell application "System Events"',
    '  key code 8 using {control down}', // Ctrl+C interrupt
    'end tell'
  ].join('\n');
  const typeAndEnterScript = [
    'tell application "System Events"',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', interruptScript], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
      return;
    }

    setTimeout(() => {
      execFile('osascript', ['-e', typeAndEnterScript], err2 => {
        if (err2) {
          console.warn('mac macro failed (enable Accessibility for terminal/app):', err2.message);
        }
      });
    }, 300);
  });
}

function sendMacroLinux(text) {
  execFile(
    'xdotool',
    [
      'key', '--clearmodifiers', 'ctrl+c',
      'type', '--delay', '1', '--clearmodifiers', '--', text,
      'key', 'Return',
    ],
    err => {
      if (err) {
        console.warn('linux macro failed. Install xdotool:', err.message);
      }
    }
  );
}

// ── App lifecycle ───────────────────────────────────────────────────────────
function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(t('tooltip'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('settings'), click: () => openSettings() },
      { type: 'separator' },
      { label: t('quit'), click: () => app.quit() },
    ])
  );
}

app.whenReady().then(async () => {
  loadSettings();
  installKeyboardHook(); // Ctrl+Q: drop lash / quit app (Windows)
  tray = new Tray(await getTrayIcon());
  buildTrayMenu();
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
