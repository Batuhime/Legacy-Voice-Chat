import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  where,
  getDocs,
  deleteDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let currentUser = null;

/* ================= 1. AUTH & BAŞLANGIÇ ================= */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  currentUser = user;

  // Navbar Güncelleme
  document.getElementById("navUsername").innerText = user.displayName || "Ejderha Lordu";
  document.getElementById("navAvatar").src = user.photoURL || "assets/img/default-avatar.png";

  loadRooms();
  updateDashboardBellIcon();
});

/* Bildirim çanı – kanala giriş/çıkış tarayıcı bildirimi */
function updateDashboardBellIcon() {
  const btn = document.getElementById("dashboardBellBtn");
  const iconOn = document.getElementById("dashboardBellIcon");
  const iconOff = document.getElementById("dashboardBellIconOff");
  if (!btn || !iconOn || !iconOff) return;
  const enabled = typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("roomNotifications") === "1";
  btn.classList.toggle("active", !!enabled);
  iconOn.style.display = enabled ? "" : "none";
  iconOff.style.display = enabled ? "none" : "";
}

document.getElementById("dashboardBellBtn")?.addEventListener("click", () => {
  if (typeof Notification === "undefined") {
    alert("Bu tarayıcı bildirimleri desteklemiyor.");
    return;
  }
  if (Notification.permission === "denied") {
    alert("Bildirimler engelli. Tarayıcı ayarlarından izin ver.");
    return;
  }
  if (Notification.permission === "default") {
    Notification.requestPermission().then((p) => {
      if (p === "granted") {
        localStorage.setItem("roomNotifications", "1");
        updateDashboardBellIcon();
        alert("Bildirimler açıldı. Kanala biri girince veya çıkınca haber alacaksın.");
      }
    });
    return;
  }
  const current = localStorage.getItem("roomNotifications") === "1";
  localStorage.setItem("roomNotifications", current ? "0" : "1");
  updateDashboardBellIcon();
  alert(current ? "Bildirimler kapatıldı." : "Bildirimler açıldı.");
});

/* ================= 2. ODALARI YÜKLE (REALTIME) ================= */
function loadRooms() {
  const q = query(collection(db, "rooms"), orderBy("createdAt", "desc"));

  onSnapshot(q, (snapshot) => {
    const container = document.getElementById("roomsContainer");
    const totalRoomsEl = document.getElementById("totalRooms");
    const totalUsersEl = document.getElementById("totalOnlineUsers");

    if (!container) return;

    container.innerHTML = "";
    let globalUserCount = 0;
    totalRoomsEl.innerText = snapshot.size;

    if (snapshot.empty) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-ghost" style="font-size: 3rem; opacity: 0.2; margin-bottom: 15px;"></i>
          <p>Henüz bölge keşfedilmedi. İlk bölgeyi sen kur!</p>
        </div>`;
      totalUsersEl.innerText = "0";
      return;
    }

    snapshot.forEach((docSnap) => {
      const room = docSnap.data();
      const roomId = docSnap.id;
      const users = room.users || [];
      const activeCount = users.length;
      globalUserCount += activeCount;
      const features = room.features || { video: true, screenShare: true, text: true };

      const isCreator = currentUser.uid === room.creatorId;

      // Feature badges
      let featureBadges = "";
      if (features.video) featureBadges += `<span class="feature-badge"><i class="fa-solid fa-camera"></i> Video</span>`;
      if (features.screenShare) featureBadges += `<span class="feature-badge"><i class="fa-solid fa-desktop"></i> Ekran</span>`;
      if (features.text) featureBadges += `<span class="feature-badge"><i class="fa-solid fa-message"></i> Chat</span>`;

      const cardHtml = `
        <div class="room-card-modern">
          ${isCreator ? `
            <button class="delete-room-btn" data-id="${roomId}">
              <i class="fa-solid fa-trash"></i>
            </button>
          ` : ""}

          <h3>
            <i class="fa-solid ${room.icon || "fa-hashtag"}"></i>
            ${escapeHtml(room.name)}
          </h3>

          <p>${escapeHtml(room.description || "Bu bölge hakkında henüz bilgi yok.")}</p>

          ${featureBadges ? `<div class="room-features">${featureBadges}</div>` : ""}

          <div class="room-card-stats">
            <span>
              <i class="fa-solid fa-crown"></i>
              ${escapeHtml(room.creatorName || "Anonim")}
            </span>
            <span>
              <i class="fa-solid fa-users"></i>
              ${activeCount}
            </span>
          </div>

          <button class="join-room-btn" 
                  data-id="${roomId}" 
                  data-name="${escapeHtml(room.name)}">
            Bölgeye Giriş Yap
          </button>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', cardHtml);
    });

    totalUsersEl.innerText = globalUserCount;
    
    // Search fonksiyonalitesi
    document.querySelector(".search-box input")?.addEventListener("input", filterRooms);
  });
}

// Arama Filtresi
function filterRooms(e) {
  const query = e.target.value.toLowerCase();
  const cards = document.querySelectorAll(".room-card-modern");
  
  cards.forEach(card => {
    const name = card.querySelector("h3").textContent.toLowerCase();
    const desc = card.querySelector("p").textContent.toLowerCase();
    
    if (name.includes(query) || desc.includes(query)) {
      card.style.display = "";
    } else {
      card.style.display = "none";
    }
  });
}

/* ================= 3. EVENT DELEGATION (KIRILMAZ BUTONLAR) ================= */
// roomsContainer'a bir kez dinleyici ekliyoruz, içindeki butonları o yakalıyor.
document.getElementById("roomsContainer")?.addEventListener("click", async (e) => {
  const joinBtn = e.target.closest(".join-room-btn");
  const deleteBtn = e.target.closest(".delete-room-btn");

  // Odaya Girme
  if (joinBtn) {
    localStorage.setItem("currentRoomId", joinBtn.dataset.id);
    localStorage.setItem("currentRoomName", joinBtn.dataset.name);
    window.location.href = "room.html";
  }

  // Oda Silme
  if (deleteBtn) {
    const roomId = deleteBtn.dataset.id;
    if (confirm("Bölgeyi tamamen yok etmek istediğine emin misin lordum?")) {
      try {
        await deleteDoc(doc(db, "rooms", roomId));
      } catch (err) {
        alert("Bölge yok edilemedi!");
      }
    }
  }
});

/* ================= 4. ODA OLUŞTURMA ================= */
document.getElementById("confirmCreateRoom")?.addEventListener("click", async () => {
  if (!currentUser) return;

  const nameInput = document.getElementById("roomNameInput");
  const descInput = document.getElementById("roomDescInput");
  const iconInput = document.getElementById("selectedIconInput");
  const enableVideo = document.getElementById("enableVideo").checked;
  const enableScreenShare = document.getElementById("enableScreenShare").checked;
  const enableText = document.getElementById("enableText").checked;

  const name = nameInput.value.trim();
  const desc = descInput.value.trim();
  const icon = iconInput.value || "fa-hashtag";

  if (!name) {
    alert("Bölgenin bir adı olmalı!");
    return;
  }

  try {
    // 1 kullanıcı 1 oda kontrolü
    const existingQuery = query(collection(db, "rooms"), where("creatorId", "==", currentUser.uid));
    const existing = await getDocs(existingQuery);

    if (!existing.empty) {
      alert("Hükmettiğin bir bölge zaten var. Yenisini kurmak için eskisini silmelisin.");
      return;
    }

    await addDoc(collection(db, "rooms"), {
      name: name,
      description: desc,
      icon: icon,
      creatorId: currentUser.uid,
      creatorName: currentUser.displayName || "Anonim",
      createdAt: serverTimestamp(),
      users: [],
      features: {
        video: enableVideo,
        screenShare: enableScreenShare,
        text: enableText
      }
    });

    // Reset ve Kapat
    nameInput.value = "";
    descInput.value = "";
    iconInput.value = "fa-hashtag";
    document.getElementById("enableVideo").checked = true;
    document.getElementById("enableScreenShare").checked = true;
    document.getElementById("enableText").checked = true;
    closeCreateModal();

  } catch (err) {
    console.error(err);
    alert("Bölge inşası sırasında bir hata oluştu.");
  }
});

/* ================= 5. MODAL & LOGOUT ================= */
const openCreateModal = () => document.getElementById("createRoomModal")?.classList.add("active");
const closeCreateModal = () => document.getElementById("createRoomModal")?.classList.remove("active");

document.getElementById("createRoomBtn")?.addEventListener("click", openCreateModal);
document.getElementById("closeCreateModal")?.addEventListener("click", closeCreateModal);

// Modal dışına tıklanırsa kapat
document.getElementById("createRoomModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeCreateModal();
});

// Profil Dropdown Menüsü
document.getElementById("profileToggle")?.addEventListener("click", () => {
  const menu = document.getElementById("profileMenu");
  menu?.classList.toggle("active");
});

// Dropdown dışında tıklanırsa kapat
document.addEventListener("click", (e) => {
  const menu = document.getElementById("profileMenu");
  const toggle = document.getElementById("profileToggle");
  if (!menu?.contains(e.target) && !toggle?.contains(e.target)) {
    menu?.classList.remove("active");
  }
});

// Icon Selector
document.querySelectorAll(".icon-option")?.forEach(option => {
  option.addEventListener("click", function() {
    document.querySelectorAll(".icon-option").forEach(o => o.classList.remove("selected"));
    this.classList.add("selected");
    const selectedIcon = this.getAttribute("data-icon");
    document.getElementById("selectedIconInput").value = selectedIcon;
  });
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  signOut(auth).then(() => { window.location.href = "index.html"; });
});

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}