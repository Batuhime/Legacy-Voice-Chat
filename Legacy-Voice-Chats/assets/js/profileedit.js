import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  updateProfile,
  signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  collection,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let currentUser = null;

/* ================= 1. AUTH KONTROL ================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  currentUser = user;
  loadProfileData();
});

/* ================= 2. PROFIL VERİLERİNİ YÜKLE ================= */
async function loadProfileData() {
  try {
    const profileRef = doc(db, "profiles", currentUser.uid);
    const profileSnap = await getDoc(profileRef);

    if (profileSnap.exists()) {
      const data = profileSnap.data();
      
      document.getElementById("displayName").value = data.displayName || currentUser.displayName || "";
      document.getElementById("bio").value = data.bio || "";
      document.getElementById("status").value = data.status || "";
      document.getElementById("twitter").value = data.twitter || "";
      document.getElementById("discord").value = data.discord || "";
      document.getElementById("twitch").value = data.twitch || "";
    } else {
      // Varsayılan değerler
      document.getElementById("displayName").value = currentUser.displayName || "";
    }

    // Avatar yükle
    if (currentUser.photoURL) {
      document.getElementById("profileAvatar").src = currentUser.photoURL;
    }

    // Character count güncelle
    updateCharCounts();

  } catch (error) {
    console.error("Profil yükleme hatası:", error);
    showToast("Profil yüklenirken hata oluştu", "error");
  }
}

/* ================= 3. AVATAR DEĞİŞTİR ================= */
document.getElementById("changeAvatarBtn")?.addEventListener("click", () => {
  document.getElementById("avatarInput").click();
});

document.getElementById("avatarInput")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    // Dosyayı Base64'e dönüştür
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Data = event.target?.result;
      
      // Preview göster
      document.getElementById("profileAvatar").src = base64Data;

      // Firebase Auth'ta fotoğraf URL'i güncelle
      // (Not: Base64 doğrudan photoURL'e giremez. URL olmalı)
      // Alternatif: IndexedDB veya localStorage'da sakla
      localStorage.setItem("profile_avatar_base64", base64Data);

      showToast("Fotoğraf güncellendi!", "success");
    };
    reader.readAsDataURL(file);

  } catch (error) {
    console.error("Avatar yükleme hatası:", error);
    showToast("Fotoğraf yüklenemedi", "error");
  }
});

/* ================= 4. CHARACTER COUNT ================= */
function updateCharCounts() {
  const fields = [
    { id: "displayName", max: 30 },
    { id: "bio", max: 150 },
    { id: "status", max: 50 },
    { id: "twitter", max: 20 },
    { id: "discord", max: 37 },
    { id: "twitch", max: 25 }
  ];

  fields.forEach(field => {
    const element = document.getElementById(field.id);
    const parent = element?.parentElement;
    const counter = parent?.querySelector(".char-count");

    if (element && counter) {
      element.addEventListener("input", () => {
        counter.textContent = `${element.value.length}/${field.max}`;
      });

      // İlk değeri göster
      counter.textContent = `${element.value.length}/${field.max}`;
    }
  });
}

/* ================= 5. FORM SUBMIT ================= */
document.getElementById("profileForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentUser) return;

  const btn = e.target.querySelector(".btn-save");
  btn.classList.add("loading");

  try {
    const displayName = document.getElementById("displayName").value.trim();
    const bio = document.getElementById("bio").value.trim();
    const status = document.getElementById("status").value.trim();
    const twitter = document.getElementById("twitter").value.trim();
    const discord = document.getElementById("discord").value.trim();
    const twitch = document.getElementById("twitch").value.trim();

    if (!displayName) {
      showToast("Görünen ad boş bırakılamaz!", "error");
      btn.classList.remove("loading");
      return;
    }

    // Firebase Auth'ta displayName güncelle
    await updateProfile(currentUser, {
      displayName: displayName,
      photoURL: currentUser.photoURL  // Ensure photoURL stays updated
    });

    // Firestore'da profil belgesi oluştur/güncelle
    const profileRef = doc(db, "profiles", currentUser.uid);
    await setDoc(profileRef, {
      displayName: displayName,
      photoURL: currentUser.photoURL,  // Store in Firestore too
      bio: bio,
      status: status,
      twitter: twitter,
      discord: discord,
      twitch: twitch,
      updatedAt: serverTimestamp(),
      userId: currentUser.uid
    }, { merge: true });

    showToast("Profil başarıyla güncellendi! ✨", "success");

  } catch (error) {
    console.error("Kaydetme hatası:", error);
    showToast("Değişiklikler kaydedilemedi", "error");
  } finally {
    btn.classList.remove("loading");
  }
});

/* ================= 6. LOGOUT ================= */
document.getElementById("logoutProfileBtn")?.addEventListener("click", async () => {
  if (!confirm("Çıkış yapmak istediğine emin misin?")) return;

  try {
    await signOut(auth);
    window.location.href = "index.html";
  } catch (error) {
    console.error("Çıkış hatası:", error);
    showToast("Çıkış yapılamadı", "error");
  }
});

/* ================= 7. BACK BUTTON ================= */
document.querySelector(".back-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  window.history.back();
});

/* ================= 8. TOAST NOTIFICATION ================= */
function showToast(message, type = "success") {
  const toast = document.getElementById("toastNotification");
  const messageEl = document.getElementById("toastMessage");

  if (!toast) return;

  messageEl.textContent = message;
  
  // Ikon güncelle
  const icon = toast.querySelector("i");
  if (type === "error") {
    icon.className = "fa-solid fa-exclamation-circle";
    toast.style.borderColor = "rgba(255, 77, 77, 0.5)";
    toast.style.background = "rgba(255, 77, 77, 0.1)";
    toast.style.color = "#ff4d4d";
  } else {
    icon.className = "fa-solid fa-check-circle";
    toast.style.borderColor = "rgba(0, 255, 136, 0.5)";
    toast.style.background = "rgba(0, 255, 136, 0.1)";
    toast.style.color = "#00ff88";
  }

  toast.classList.add("show");

  // 3 saniye sonra gizle
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}