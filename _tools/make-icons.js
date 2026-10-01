const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

async function shoot(mode, name) {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, 'duck-draw.html'), { query: { mode } });
  await win.webContents.executeJavaScript('window.__done === true');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  for (const size of [256, 128, 64, 48, 32]) {
    const small = img.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(OUT, `${name}-${size}.png`), small.toPNG());
  }
  win.destroy();
}

app.whenReady().then(async () => {
  await shoot('color', 'duck');
  await shoot('silhouette', 'duck-template');
  console.log('ICONS_DONE');
  app.quit();
});
