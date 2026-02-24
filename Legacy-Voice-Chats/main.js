const { app, BrowserWindow, session, shell } = require('electron'); // session eklendi
const path = require('path');

let mainWindow; // Global değişken olarak tanımladık

// Protokol Ayarları
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('legacy-app', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('legacy-app')
}

async function createWindow() {
    // --- GOOGLE HESAP SEÇİMİNİ ZORLAMAK İÇİN ÇEREZLERİ TEMİZLE ---
    // Bu kısım her açılışta eski Google oturumlarını temizler
    await session.defaultSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'cache']
    });

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "LEGACY",
        // PENCERE İKONU (Dosya yolunun assets/img/icon.ico olduğundan emin ol)
        icon: path.join(__dirname, 'assets/img/icon.ico'), 
        frame: false, 
        titleBarStyle: 'hidden', 
        titleBarOverlay: {
            color: '#050505', 
            symbolColor: '#ffffff', 
            height: 40
        },
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // Google Login için gerekli güvenli pencere ayarı
            sandbox: true 
        }
    });

    // Klasik menü çubuğunu gizle
    mainWindow.setMenuBarVisibility(false);

    // Uygulama adresini yükle
    mainWindow.loadURL('https://legacy-d4f53.web.app', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
}

// Protokol üzerinden gelen (tarayıcıdan dönen) Auth bilgisini yakalama
app.on('open-url', (event, url) => {
    event.preventDefault();
    const token = new URL(url).searchParams.get('token');
    if (token && mainWindow) {
        mainWindow.webContents.send('auth-success', token);
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});