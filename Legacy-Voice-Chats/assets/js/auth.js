// Az önce oluşturduğumuz config dosyasından araçları alıyoruz
import { auth, provider, signInWithPopup, onAuthStateChanged } from "./firebase-config.js";

// HTML'deki butonu seçelim
const loginBtn = document.getElementById('googleLoginBtn');

// Butona tıklanınca çalışacak olay
if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
        try {
            // Butona "Yükleniyor" efekti ver
            loginBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Bağlanılıyor...';
            
            // Google penceresini aç
            const result = await signInWithPopup(auth, provider);
            const user = result.user;

            console.log("Giriş Başarılı:", user.displayName);

            // Kullanıcı bilgilerini tarayıcı hafızasına al (Dashboard'da göstermek için)
            localStorage.setItem('user_name', user.displayName);
            localStorage.setItem('user_photo', user.photoURL);
            localStorage.setItem('user_uid', user.uid);

            // Dashboard'a yönlendir
            window.location.href = "dashboard.html";

        } catch (error) {
            console.error("Hata:", error);
            alert("Giriş başarısız: " + error.message);
            
            // Butonu eski haline getir
            loginBtn.innerHTML = '<img src="https://upload.wikimedia.org/wikipedia/commons/5/53/Google_%22G%22_Logo.svg" alt="G"> <span>Google ile Bağlan</span>';
        }
    });
}

// Kullanıcı zaten giriş yapmış mı kontrol et (Sayfa yenilenirse çıkış yapmasın)
onAuthStateChanged(auth, (user) => {
    if (user && window.location.pathname.includes('index.html')) {
        // Zaten giriş yapmışsa direkt dashboard'a at
        window.location.href = "dashboard.html";
    }
});