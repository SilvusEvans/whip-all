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
// cursor position from the main process. The lash is dropped via the quit hotkey
// or the tray icon, not by clicking the screen.
let cursorTimer = null;        // lightweight cursor-poll timer
let overlayOffset = { x: 0, y: 0 }; // overlay window's screen origin (for cursor mapping)

// Keyboard hook for the quit hotkey (Windows only), installed for the app's
// whole lifetime: while the lash is on screen the hotkey drops it; otherwise
// the hotkey quits the app. Both cases consume the key so it never leaks into
// the foreground application.
let kbHookHandle = 0;        // WH_KEYBOARD_LL hook handle (0 = not installed)
let kbHookCbRef = null;       // keeps the registered JS callback alive
let hotkeyCapture = false;    // settings window is recording a new quit hotkey
const VK_SHIFT = 0x10;
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;

// ── Quit hotkey ─────────────────────────────────────────────────────────────
// Stored as `{ ctrl, alt, shift, code }` (`code` = a KeyboardEvent.code, so the
// settings window can record it from a keydown without knowing VK numbers).
// This table is the single source of truth mapping that code to the Win32 VK the
// low-level hook reports and to the label shown in the UI; the settings window
// validates a recording through IPC instead of keeping its own copy, so the two
// can never drift apart.
const DEFAULT_QUIT_HOTKEY = { ctrl: true, alt: false, shift: false, code: 'KeyQ' };

const HOTKEY_KEYS = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    map['Key' + ch] = { vk: 0x41 + i, label: ch };
  }
  for (let d = 0; d < 10; d++) {
    map['Digit' + d] = { vk: 0x30 + d, label: String(d) };
    map['Numpad' + d] = { vk: 0x60 + d, label: 'Num' + d };
  }
  for (let f = 1; f <= 12; f++) map['F' + f] = { vk: 0x6f + f, label: 'F' + f };
  Object.assign(map, {
    ArrowUp: { vk: 0x26, label: 'Up' },      ArrowDown: { vk: 0x28, label: 'Down' },
    ArrowLeft: { vk: 0x25, label: 'Left' },  ArrowRight: { vk: 0x27, label: 'Right' },
    Home: { vk: 0x24, label: 'Home' },       End: { vk: 0x23, label: 'End' },
    PageUp: { vk: 0x21, label: 'PageUp' },   PageDown: { vk: 0x22, label: 'PageDown' },
    Space: { vk: 0x20, label: 'Space' },     Enter: { vk: 0x0d, label: 'Enter' },
    NumpadEnter: { vk: 0x0d, label: 'NumEnter' }, Escape: { vk: 0x1b, label: 'Esc' },
    Tab: { vk: 0x09, label: 'Tab' },         Backspace: { vk: 0x08, label: 'Bksp' },
    Semicolon: { vk: 0xba, label: ';' },     Equal: { vk: 0xbb, label: '=' },
    Comma: { vk: 0xbc, label: ',' },         Minus: { vk: 0xbd, label: '-' },
    Period: { vk: 0xbe, label: '.' },        Slash: { vk: 0xbf, label: '/' },
    Backquote: { vk: 0xc0, label: '`' },     BracketLeft: { vk: 0xdb, label: '[' },
    Backslash: { vk: 0xdc, label: '\\' },    BracketRight: { vk: 0xdd, label: ']' },
    Quote: { vk: 0xde, label: "'" },
    NumpadMultiply: { vk: 0x6a, label: 'Num*' }, NumpadAdd: { vk: 0x6b, label: 'Num+' },
    NumpadSubtract: { vk: 0x6d, label: 'Num-' }, NumpadDecimal: { vk: 0x6e, label: 'Num.' },
    NumpadDivide: { vk: 0x6f, label: 'Num/' },
  });
  return map;
})();

/** Accept only a known key plus at least one modifier: a bare key would be
 *  swallowed everywhere on the desktop (a modifier-less "Q" means no typing). */
function normalizeHotkey(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = typeof raw.code === 'string' ? raw.code : '';
  if (!HOTKEY_KEYS[code]) return null;
  const hk = { ctrl: !!raw.ctrl, alt: !!raw.alt, shift: !!raw.shift, code };
  if (!hk.ctrl && !hk.alt && !hk.shift) return null;
  return hk;
}

function hotkeyLabel(raw) {
  const hk = normalizeHotkey(raw) || DEFAULT_QUIT_HOTKEY;
  return [hk.ctrl && 'Ctrl', hk.alt && 'Alt', hk.shift && 'Shift', HOTKEY_KEYS[hk.code].label]
    .filter(Boolean)
    .join('+');
}

// ── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(os.homedir(), '.whipall.json');
const DEFAULT_SETTINGS = {
  language: 'en',            // UI language: 'en' | 'zh' | 'zh-TW' | 'ja'
  theme: 'dark',             // UI theme: 'dark' | 'light'
  themeColor: '#6750a4',     // accent color (settings + lash)
  autoSwitchEnglish: true,   // switch IME to English before cracking
  showStatusBadge: true,     // show live foreground status badge above the lash
  statusPollMs: 300,         // how often to poll foreground state (ms)
  quitHotkey: { ...DEFAULT_QUIT_HOTKEY }, // drop the lash / quit the app
  firstRunHintDone: false,   // one-off tray hint telling the user the hotkey
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
  en:    { settings: 'Settings', quit: 'Quit', tooltip: 'Whip-All - click to crack', title: 'Whip-All Settings',
           hint_title: 'Whip-All is running',
           hint_body: 'Click the tray icon to summon the whip. Press {hotkey} to drop the lash, or quit the app when no lash is on screen.' },
  zh:    { settings: '设置', quit: '退出', tooltip: 'Whip-All - 点击挥鞭', title: 'Whip-All 设置',
           hint_title: 'Whip-All 已启动',
           hint_body: '点击托盘图标召唤鞭子。按 {hotkey} 放下鞭子；屏幕上没有鞭子时按它会退出程序。' },
  'zh-TW': { settings: '設定', quit: '退出', tooltip: 'Whip-All - 點擊揮鞭', title: 'Whip-All 設定',
           hint_title: 'Whip-All 已啟動',
           hint_body: '點擊托盤圖標召喚鞭子。按 {hotkey} 放下鞭子；螢幕上沒有鞭子時按它會退出程式。' },
  ja:    { settings: '設定', quit: '終了', tooltip: 'Whip-All - クリックで煽る', title: 'Whip-All 設定',
           hint_title: 'Whip-All 起動中',
           hint_body: 'トレイアイコンをクリックで鞭を出します。{hotkey} で鞭を下げます。鞭がないときは終了します。' },
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
      settings.quitHotkey = normalizeHotkey(settings.quitHotkey) || { ...DEFAULT_QUIT_HOTKEY };
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
// to the pointer. Dropping the lash: the quit hotkey (keyboard hook) or the tray icon.

function getCursorNow() {
  try {
    return screen.getCursorScreenPoint();
  } catch (e) {
    return null;
  }
}

// Low-level keyboard hook for the quit hotkey, installed once at startup. While
// the lash overlay is visible the hotkey drops the lash; otherwise it quits the
// app. Both cases consume the key so it never leaks into the foreground app.
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
        const hk = settings.quitHotkey || DEFAULT_QUIT_HOTKEY;
        const wanted = HOTKEY_KEYS[hk.code];
        // hotkeyCapture: the settings window is recording a new combination, so the
        // current one must behave like a normal key and reach that window.
        if (!hotkeyCapture && wanted && nCode >= 0 && wParam === WM_KEYDOWN && vk === wanted.vk) {
          // Match the modifier state exactly (live key state, not the event's).
          const down = v => GetAsyncKeyState ? (GetAsyncKeyState(v) & 0x8000) !== 0 : false;
          if (down(VK_CONTROL) === hk.ctrl && down(VK_MENU) === hk.alt && down(VK_SHIFT) === hk.shift) {
            if (overlay && overlay.isVisible() && !overlay.isDestroyed()) {
              // Lash on screen: the hotkey drops it. Overlay ignores this if it
              // is already dropping, so a repeated press is harmless.
              overlay.webContents.send('cursor-down');
            } else {
              // No lash: the hotkey quits the app.
              app.quit();
            }
            return 1; // consume: the hotkey never reaches the foreground app
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
    console.warn('installKeyboardHook failed (quit hotkey unavailable):', e?.message || e);
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
//
// The poll rate deliberately does NOT try to match the display refresh rate:
// the overlay interpolates between samples on its own requestAnimationFrame
// clock. Polling faster just makes the newest sample fresher (and shortens the
// interpolation delay), so this can stay well below the refresh rate.
const CURSOR_POLL_MS = 8;

function startCursorTracking() {
  stopCursorTracking();
  const tick = () => {
    if (overlay && overlay.isVisible() && !overlay.isDestroyed() && overlayReady) {
      const p = getCursorNow();
      // Every sample carries a timestamp. The overlay renders on a different
      // clock than this timer, so without it the handle could only snap to the
      // last poll — which made it advance in irregular steps and made the
      // frame-to-frame aim velocity alternate between 0 and 2x (visible twitch).
      if (p) overlay.webContents.send('cursor', p.x - overlayOffset.x, p.y - overlayOffset.y, Date.now());
      cursorTimer = setTimeout(tick, CURSOR_POLL_MS);
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
  if (p) overlay.webContents.send('cursor', p.x - overlayOffset.x, p.y - overlayOffset.y, Date.now());
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
// The renderer gets the hotkey back with a ready-to-show label so it never has
// to re-derive one from VK numbers.
function settingsForRenderer() {
  return { ...settings, quitHotkeyLabel: hotkeyLabel(settings.quitHotkey) };
}
ipcMain.handle('get-settings', () => settingsForRenderer());
ipcMain.handle('validate-hotkey', (e, hk) => {
  const normalized = normalizeHotkey(hk);
  if (!normalized) return { ok: false, error: 'invalid', label: hotkeyLabel(settings.quitHotkey) };
  return { ok: true, hotkey: normalized, label: hotkeyLabel(normalized) };
});
// While the settings window records a combination, the global hook must not eat
// the very keys the user is pressing to build it.
ipcMain.on('hotkey-capture', (e, on) => { hotkeyCapture = !!on; });
ipcMain.handle('save-settings', (e, patch) => {
  try {
    if (patch && patch.quitHotkey !== undefined && !normalizeHotkey(patch.quitHotkey)) {
      return { ok: false, error: 'invalid_hotkey' };
    }
    settings = { ...settings, ...(patch || {}) };
    if (!Array.isArray(settings.phrases) || settings.phrases.length === 0) {
      settings.phrases = DEFAULT_SETTINGS.phrases;
    }
    settings.quitHotkey = normalizeHotkey(settings.quitHotkey) || { ...DEFAULT_QUIT_HOTKEY };
    saveSettings();
    // Refresh tray menu/tooltip immediately so language changes apply at once.
    if (patch && (patch.language || patch.theme || patch.quitHotkey)) buildTrayMenu();
    return { ok: true, settings: settingsForRenderer() };
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
  settingsWin.on('closed', () => {
    settingsWin = null;
    hotkeyCapture = false; // never leave the quit hotkey disabled
  });
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
  const hk = hotkeyLabel(settings.quitHotkey);
  tray.setToolTip(`${t('tooltip')}  |  ${hk}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('settings'), click: () => openSettings() },
      { type: 'separator' },
      { label: `${t('quit')}  (${hk})`, click: () => app.quit() },
    ])
  );
}

// One-off tray balloon on the first run, telling the user how to get out —
// without it a tray-only app looks like it never started. Windows-only API.
function showFirstRunHint() {
  if (settings.firstRunHintDone || process.platform !== 'win32' || !tray) return;
  try {
    tray.displayBalloon({
      title: t('hint_title'),
      content: t('hint_body').replace('{hotkey}', hotkeyLabel(settings.quitHotkey)),
    });
  } catch (e) {
    console.warn('first-run hint failed:', e?.message || e);
  }
  settings.firstRunHintDone = true;
  saveSettings();
}

app.whenReady().then(async () => {
  loadSettings();
  installKeyboardHook(); // quit hotkey: drop lash / quit app (Windows)
  tray = new Tray(await getTrayIcon());
  buildTrayMenu();
  tray.on('click', toggleOverlay);
  showFirstRunHint();
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
