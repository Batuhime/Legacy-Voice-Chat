# Legacy Voice & Video Chat Application

Bu proje, kullanıcılar arasında gerçek zamanlı (real-time) ve düşük gecikmeli (low-latency) ses ve video iletişimi sağlayan, **Electron.js** tabanlı bir masaüstü uygulamasıdır. Ağ trafiği optimizasyonu ve veri aktarımı odaklı geliştirilmiştir.

## 🚀 Özellikler
* **Gerçek Zamanlı İletişim:** Agora WebRTC SDK kullanılarak kesintisiz ses ve görüntü aktarımı.
* **Kullanıcı Yönetimi:** Firebase Authentication ve Realtime Database ile güvenli giriş ve veri tutma.
* **Masaüstü Uyumluluğu:** Electron.js ile paketlenmiş, Windows tabanlı bağımsız çalışabilen (.exe) yapısı.
* **Düşük Gecikme (Low-Latency):** Ağ paketlerinin optimize edilmesiyle sağlanan yüksek performanslı iletişim.

## 🛠️ Kullanılan Teknolojiler
* **Altyapı:** Node.js, JavaScript, HTML, CSS
* **Masaüstü Çerçevesi:** Electron.js
* **İletişim & Ağ:** Agora WebRTC SDK
* **Veritabanı & Kimlik Doğrulama:** Firebase

## ⚙️ Kurulum ve Çalıştırma (Geliştiriciler İçin)
Güvenlik nedeniyle `Firebase Config` ve `Agora App ID` bilgileri kod içerisinden temizlenmiştir. Projeyi lokalinizde çalıştırmak için aşağıdaki adımları izleyin:

1. Projeyi bilgisayarınıza klonlayın.
2. Terminalde proje dizinine giderek gerekli paketleri yükleyin:
   \`npm install\`
3. Kendi **Firebase Config** ayarlarınızı `firebase-config` ekleyin.
4. Kendi **Agora App ID** bilginizi  room-simple.js ve room.js script dosyasına ekleyin.
5. Uygulamayı başlatın:
   \`npm start\`

---
*Geliştirici: Batuhan Koç*