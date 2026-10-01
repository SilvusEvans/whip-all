const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true });
    await win.loadFile(path.join(__dirname, 'duck-draw.html'), { query: { mode: 'silhouette' } });
    await new Promise(r => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'out', 'duck-template.png'), img.toPNG());
    const small = img.resize({ width: 32, height: 32, quality: 'best' });
    fs.writeFileSync(path.join(__dirname, 'out', 'duck-template-32.png'), small.toPNG());
    console.log('TEMPLATE_DONE');
  } catch (e) { console.error('TEMPLATE_FAIL', e.message); }
  app.quit();
});
