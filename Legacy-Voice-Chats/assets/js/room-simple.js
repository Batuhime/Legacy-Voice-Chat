// ============================================
// LEGACY VOICE CHAT - SIMPLIFIED VERSION
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    doc, updateDoc, collection, onSnapshot, query, orderBy, getDoc, addDoc 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// GLOBALS
const AGORA_APP_ID = "";
let client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" }); // VP8 for multitrack support
let localAudioTrack;
let currentUser = null;
let CHANNEL_NAME = "";
let currentRoomName = "";
let isMicMuted = false;
let isAudioMuted = false;
let isJoining = false;

console.log("🚀 room-simple.js yüklendi");

// ============================================
// APP START
// ============================================
onAuthStateChanged(auth, async (user) => {
    console.log("👤 Auth state changed:", user ? "✅ Logged in" : "❌ Logged out");
    
    if (!user) {
        window.location.href = "index.html";
        return;
    }
    
    if (!isJoining) {
        isJoining = true;
        currentUser = user;
        CHANNEL_NAME = localStorage.getItem("currentRoomId");
        currentRoomName = localStorage.getItem("currentRoomName");
        
        console.log("📍 Room:", CHANNEL_NAME, "|", currentRoomName);
        
        if (!CHANNEL_NAME) {
            window.location.href = "dashboard.html";
            return;
        }
        
        // Update UI header
        const header = document.getElementById("roomHeader");
        if (header) {
            header.innerHTML = `<i class="fa-solid fa-hashtag"></i> ${currentRoomName}`;
            header.style.opacity = "1";
        }
        
        // Start connection
        startConnection();
    }
});

// ============================================
// CONNECTION
// ============================================
async function startConnection() {
    console.log("🔗 startConnection() başladı");
    
    const timeout = 45000;
    const timeoutId = setTimeout(() => {
        console.error("❌ TIMEOUT: 45 saniye geçti");
        showError("Bağlantı zaman aşımına uğradı. Sayfayı yenileyip dene.");
        isJoining = false;
        updateBubbleStage("❌ TIMEOUT<br><small>Sayfayı yenile (F5)</small>");
    }, timeout);
    
    try {
        // 1. Firestore'a user ekle
        console.log("1️⃣ Firestore'a user ekleniyor...");
        await addUserToRoom();
        console.log("✅ User eklendi");
        
        // 2. Agora join
        console.log("2️⃣ Agora'ya katılınıyor...");
        await client.join(AGORA_APP_ID, CHANNEL_NAME, null, currentUser.uid);
        console.log("✅ Agora join başarılı");
        
        // 3. Mikrofon oluştur
        console.log("3️⃣ Mikrofon oluşturuluyor...");
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: {
                sampleRate: 48000,
                stereo: true,
                channel: 2,
                bitrate: 128
            },
            AEC: true,
            ANS: true,
            AGC: true
        });
        console.log("✅ Mikrofon hazırlandı");
        
        // 4. Publish
        console.log("4️⃣ Audio track publish ediliyor...");
        await client.publish([localAudioTrack]);
        console.log("✅ Audio track published");
        
        // 5. Event handlers
        console.log("5️⃣ Event handlers kuruluyor...");
        setupEventHandlers();
        
        // 6. Remote users subscribe
        console.log("6️⃣ Mevcut remote users'a subscribe...");
        for (let remote of client.remoteUsers) {
            try {
                await client.subscribe(remote, "audio");
                if (remote.audioTrack) await remote.audioTrack.play();
                console.log("✅ Subscribed to remote:", remote.uid);
            } catch (err) {
                console.warn("Subscribe/play fail for", remote.uid, ":", err);
            }
        }
        
        // 7. Chat ve user sync
        console.log("7️⃣ Chat ve sync başlıyor...");
        initChat();
        syncUsers();
        
        clearTimeout(timeoutId);
        isJoining = false;
        
        console.log("🎉 BAĞLANTI TAMAMLANDI!");
        showSuccess("✨ Bölgeye başarıyla bağlanıldı!");
        updateBubbleStage("");
        updateRoomBellIcon();
        getDevices();

    } catch (err) {
        clearTimeout(timeoutId);
        console.error("❌ HATA:", err.message || err);
        showError(err.message || "Bağlantı hatası");
        isJoining = false;
        updateBubbleStage(`❌ ${err.message}<br><small>Sayfayı yenile (F5)</small>`);
    }
}

// ============================================
// FIRESTORE OPERATIONS
// ============================================
async function addUserToRoom() {
    const roomRef = doc(db, "rooms", CHANNEL_NAME);
    const snap = await getDoc(roomRef);
    
    if (!snap.exists()) {
        throw new Error(`Oda bulunamadı: ${CHANNEL_NAME}`);
    }
    
    const users = (snap.data().users || []).filter(u => u.uid !== currentUser.uid);
    users.push({
        uid: currentUser.uid,
        name: currentUser.displayName || "User",
        photo: currentUser.photoURL || "assets/img/default-avatar.png",
        isMuted: false
    });
    
    await updateDoc(roomRef, { users });
}

// ============================================
// AGORA EVENTS
// ============================================
function setupEventHandlers() {
    // User joined & published media
    client.on("user-published", async (user, mediaType) => {
        console.log("📢 User published:", user.uid, mediaType);
        try {
            await client.subscribe(user, mediaType);
            
            // 1. SES GELDİYSE OYNAT
            if (mediaType === "audio" && user.audioTrack && !isAudioMuted) {
                await user.audioTrack.play();
            }
            
            // 2. VİDEO GELDİYSE EKRANA BAS (Burası eksikti! 🎯)
            if (mediaType === "video" && user.videoTrack) {
                // İsmini bulmaya çalış, bulamazsa ID'sini yaz
                const remoteName = previousRoomUserNames[user.uid] || `Kullanıcı ${String(user.uid).slice(-4)}`;
                
                // Diğer kullanıcının videosunu bizim "videoStage" alanına ekle
                await attachVideoTrack(user.videoTrack, user.uid, remoteName, "camera");
            }
        } catch (err) {
            console.warn("Subscribe error:", err);
        }
    });

    // User left or stopped media
    client.on("user-unpublished", (user, mediaType) => {
        console.log("📴 User unpublished:", user.uid, mediaType);
        
        if (mediaType === "audio" && user.audioTrack) {
            user.audioTrack.stop();
        }
        
        // VİDEOYU KAPATTIYSA EKRANDAN SİL (Bunu da ekliyoruz 🧹)
        if (mediaType === "video") {
            removeVideoTrack(user.uid);
        }
    });

    // Konuşan kişi göstergesi (yeşil yanma) + durum çubuğu
    client.on("volume-indicator", (volumes) => {
        document.querySelectorAll(".user-bubble, .user-card").forEach(el => el.classList.remove("speaking"));
        const speakerStatus = document.getElementById("speakerStatus");
        const currentSpeakerText = document.getElementById("currentSpeakerText");

        let speakingName = null;
        volumes.forEach((v) => {
            if (v.level <= 5) return;
            const targetId = (v.uid === 0 || v.uid === currentUser?.uid) ? currentUser?.uid : v.uid;
            const bubble = document.getElementById(`bubble-${targetId}`);
            const card = document.getElementById(`user-${targetId}`);
            if (bubble) bubble.classList.add("speaking");
            if (card) card.classList.add("speaking");
            const nameEl = document.querySelector(`#bubble-${targetId} .bubble-name`);
            speakingName = nameEl ? nameEl.textContent : (targetId === currentUser?.uid ? "Sen" : "Birisi");
        });

        if (speakerStatus) speakerStatus.classList.toggle("someone-speaking", !!speakingName);
        if (currentSpeakerText) currentSpeakerText.textContent = speakingName ? `Konuşan: ${speakingName}` : "Konuşan: Yok";
    });

    // Ağ kalitesi göstergesi
    client.on("network-quality", (quality) => {
        const qualityBar = document.querySelector(".quality-bars");
        const qualityText = document.getElementById("qualityText");
        if (!qualityBar || !qualityText) return;
        const levels = {
            0: { text: "Bilinmiyor", color: "#888", bars: 0 },
            1: { text: "Mükemmel", color: "#00ff88", bars: 3 },
            2: { text: "İyi", color: "#ffff00", bars: 2 },
            3: { text: "Zayıf", color: "#ff9500", bars: 1 },
            4: { text: "Kötü", color: "#ff4d4d", bars: 0 }
        };
        const q = quality.downlinkNetworkQuality;
        const level = levels[q] || levels[0];
        qualityText.textContent = level.text;
        qualityText.style.color = level.color;
        qualityBar.querySelectorAll(".quality-bar").forEach((bar, i) => {
            bar.style.backgroundColor = i < level.bars ? level.color : "#666";
            bar.style.opacity = i < level.bars ? "1" : "0.3";
        });
    });

    // Bağlantı durumu (Bağlı / Kesildi)
    client.on("connection-state-change", (curState) => {
        updateConnectionStatus(curState);
    });

    client.enableAudioVolumeIndicator();
    updateConnectionStatus(client.connectionState);
}

function updateConnectionStatus(state) {
    const dot = document.getElementById("connectionDot");
    const text = document.getElementById("connectionText");
    if (!dot || !text) return;
    dot.className = "status-dot";
    if (state === "CONNECTED") {
        dot.classList.add("connected");
        text.textContent = "Bağlı";
    } else if (state === "CONNECTING" || state === "RECONNECTING") {
        dot.classList.add("connecting");
        text.textContent = "Bağlanıyor...";
    } else {
        dot.classList.add("disconnected");
        text.textContent = "Bağlantı yok";
    }
}

// ============================================
// CHAT
// ============================================
function initChat() {
    const q = query(
        collection(db, "rooms", CHANNEL_NAME, "messages"),
        orderBy("timestamp", "asc")
    );
    
    onSnapshot(q, (snapshot) => {
        const container = document.getElementById("chatContainer");
        if (!container) return;
        
        container.innerHTML = "";
        snapshot.forEach((doc) => {
            const msg = doc.data();
            const isMe = msg.senderId === currentUser.uid;
            const timeStr = msg.timestamp 
                ? new Date(msg.timestamp.toDate()).toLocaleTimeString()
                : "...";
            
            container.innerHTML += `
                <div class="message ${isMe ? "sent" : ""}">
                    ${!isMe ? `<img src="${msg.photo}" class="msg-avatar">` : ''}
                    <div class="msg-content">
                        ${!isMe ? `<small>${msg.senderName}</small>` : ''}
                        <div>${msg.text}</div>
                        <small>${timeStr}</small>
                    </div>
                </div>`;
        });
        
        container.scrollTop = container.scrollHeight;
    });
    
    document.getElementById("sendBtn")?.addEventListener("click", sendMessage);
}

async function sendMessage() {
    const input = document.getElementById("msgInput");
    if (!input.value.trim()) return;
    
    try {
        await addDoc(collection(db, "rooms", CHANNEL_NAME, "messages"), {
            text: input.value,
            senderId: currentUser.uid,
            senderName: currentUser.displayName || "User",
            photo: currentUser.photoURL,
            timestamp: new Date()
        });
        input.value = "";
    } catch (err) {
        console.error("Send message error:", err);
    }
}

// ============================================
// USER SYNC + TARAYICI BİLDİRİMLERİ (kanala giriş/çıkış)
// ============================================
let previousRoomUserIds = new Set();
let previousRoomUserNames = {};

function syncUsers() {
    onSnapshot(doc(db, "rooms", CHANNEL_NAME), (snap) => {
        if (!snap.exists()) return;

        const users = snap.data().users || [];
        const container = document.getElementById("userListContainer");
        const stage = document.getElementById("bubbleStage");

        if (!container || !stage) return;

        const currentIds = new Set(users.map(u => u.uid));
        const roomName = currentRoomName || "Oda";

        // Tarayıcı bildirimi: sadece sekme arka plandayken, izin ve tercih açıksa
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("roomNotifications") === "1" && document.hidden) {
            users.forEach(u => {
                if (u.uid !== currentUser?.uid && !previousRoomUserIds.has(u.uid)) {
                    try {
                        new Notification("LEGACY • " + roomName, {
                            body: "🔔 " + (u.name || "Birisi") + " kanala bağlandı",
                            icon: "assets/img/icon.png"
                        });
                    } catch (e) { /* ignore */ }
                }
            });
            previousRoomUserIds.forEach(uid => {
                if (!currentIds.has(uid) && uid !== currentUser?.uid) {
                    const name = previousRoomUserNames[uid] || "Birisi";
                    try {
                        new Notification("LEGACY • " + roomName, {
                            body: "👋 " + name + " ayrıldı",
                            icon: "assets/img/icon.png"
                        });
                    } catch (e) { /* ignore */ }
                }
            });
        }
        previousRoomUserIds = new Set(users.map(u => u.uid));
        previousRoomUserNames = {};
        users.forEach(u => { previousRoomUserNames[u.uid] = u.name; });

        container.innerHTML = "";
        stage.innerHTML = "";

        users.forEach(u => {
            const isLocal = u.uid === currentUser.uid;

            stage.innerHTML += `
                <div class="user-bubble" id="bubble-${u.uid}">
                    <img src="${u.photo}" class="bubble-img">
                    <span class="bubble-name">${u.name}</span>
                </div>`;

            container.innerHTML += `
                <div class="user-card" id="user-${u.uid}">
                    <img src="${u.photo}" class="user-avatar">
                    <span>${u.name} ${isLocal ? "(Sen)" : ""}</span>
                    <i class="fa-solid ${u.isMuted ? "fa-microphone-slash" : "fa-microphone"}"></i>
                </div>`;
        });

        document.getElementById("userCount").innerText = users.length;
    });
}



window.toggleRoomNotifications = function() {
    if (typeof Notification === "undefined") {
        showNotification("Bu tarayıcı bildirimleri desteklemiyor.", "error");
        return;
    }
    if (Notification.permission === "denied") {
        showNotification("Bildirimler engelli. Tarayıcı ayarlarından izin ver.", "error");
        return;
    }
    if (Notification.permission === "default") {
        Notification.requestPermission().then(p => {
            if (p === "granted") {
                localStorage.setItem("roomNotifications", "1");
                updateRoomBellIcon();
                showNotification("Bildirimler açıldı. Kanala biri girince/çıkınca haber alacaksın.");
            } else {
                showNotification("Bildirimler kapalı.", "error");
            }
        });
        return;
    }
    const current = localStorage.getItem("roomNotifications") === "1";
    localStorage.setItem("roomNotifications", current ? "0" : "1");
    updateRoomBellIcon();
    showNotification(current ? "Bildirimler kapatıldı." : "Bildirimler açıldı.");
};

// ============================================
// UI CONTROLS
// ============================================
window.toggleMic = async function() {
    if (!localAudioTrack) return;
    isMicMuted = !isMicMuted;
    await localAudioTrack.setMuted(isMicMuted);
    
    const btn = document.getElementById("micBtn");
    btn.classList.toggle("hangup", isMicMuted);
    btn.innerHTML = `<i class="fa-solid ${isMicMuted ? "fa-microphone-slash" : "fa-microphone"}"></i>`;
};

window.toggleAudio = function() {
    const btn = document.getElementById("audioBtn");
    isAudioMuted = !isAudioMuted;
    
    client.remoteUsers.forEach(u => {
        if (u.audioTrack) {
            isAudioMuted ? u.audioTrack.stop() : u.audioTrack.play();
        }
    });
    
    btn.classList.toggle("hangup", isAudioMuted);
    btn.innerHTML = `<i class="fa-solid ${isAudioMuted ? "fa-volume-xmark" : "fa-headphones"}"></i>`;
};

// ============================================
// CLEANUP (Tab kapatılınca)
// ============================================
async function performCleanup() {
    try {
        console.log("🧹 Cleanup başladı...");
        
        if (!CHANNEL_NAME || !currentUser) return;
        
        // 1. Audio track'i kapat
        if (localAudioTrack) {
            try {
                localAudioTrack.stop();
                localAudioTrack.close?.();
            } catch (err) {
                console.warn("Audio stop error:", err);
            }
        }
        
        // 2. Remote users'ı kapat
        try {
            client.remoteUsers.forEach(u => {
                if (u.audioTrack) {
                    u.audioTrack.stop();
                }
            });
        } catch (err) {
            console.warn("Remote users stop error:", err);
        }
        
        // 3. Agora'dan ayrıl
        try {
            await client.leave();
            console.log("✅ Agora left");
        } catch (err) {
            console.warn("Agora leave error:", err);
        }
        
        // 4. Firestore'dan kaldır (önemli!)
        try {
            const roomRef = doc(db, "rooms", CHANNEL_NAME);
            const snap = await getDoc(roomRef);
            if (snap.exists()) {
                const users = (snap.data().users || []).filter(u => u.uid !== currentUser.uid);
                await updateDoc(roomRef, { users });
                console.log("✅ Firestore cleaned");
            }
        } catch (err) {
            console.warn("Firestore cleanup error:", err);
        }
        
        console.log("✅ Cleanup completed");
    } catch (err) {
        console.error("Cleanup error:", err);
    }
}

window.leaveRoom = async function() {
    await performCleanup();
    window.location.href = "dashboard.html";
};

// TAB KAPANIYOR - Firestore'dan kaldır
window.addEventListener("beforeunload", () => {
    // Synchronous cleanup sadece Firestore için
    if (CHANNEL_NAME && currentUser) {
        // Note: beforeunload async işlem beklemez, bu yüzden fetch kullanıyoruz
        navigator.sendBeacon("/api/cleanup", JSON.stringify({
            roomId: CHANNEL_NAME,
            userId: currentUser.uid
        }));
    }
});

// BETTER: pagehide event (daha güvenilir)
window.addEventListener("pagehide", async (e) => {
    if (e.persisted) return; // Bfcache ise cleanup yapma
    console.log("👋 Page is unloading...");
    await performCleanup();
});

window.openSettings = () => {
    const modal = document.getElementById("settingsModal");
    if (modal) {
        modal.classList.add("active");
        getDevices();
    }
};

window.closeSettings = () => {
    const modal = document.getElementById("settingsModal");
    if (modal) modal.classList.remove("active");
};

async function getDevices() {
    const micSelect = document.getElementById("micSelect");
    const spkSelect = document.getElementById("speakerSelect");
    if (!micSelect || !spkSelect) return;
    try {
        if (typeof AgoraRTC === "undefined") {
            micSelect.innerHTML = "<option value=''>Agora yükleniyor...</option>";
            spkSelect.innerHTML = "<option value=''>Agora yükleniyor...</option>";
            return;
        }
        const devices = await AgoraRTC.getDevices();
        micSelect.innerHTML = "";
        spkSelect.innerHTML = "";
        let micIndex = 0;
        let spkIndex = 0;
        devices.forEach((device) => {
            const option = document.createElement("option");
            option.value = device.deviceId;
            const label = device.label && device.label.trim() ? device.label : (device.kind === "audioinput" ? `Mikrofon ${++micIndex}` : `Hoparlör ${++spkIndex}`);
            option.textContent = label;
            if (device.kind === "audioinput") micSelect.appendChild(option);
            if (device.kind === "audiooutput") spkSelect.appendChild(option);
        });
        if (micSelect.options.length === 0) micSelect.innerHTML = "<option value=''>Cihaz bulunamadı</option>";
        if (spkSelect.options.length === 0) spkSelect.innerHTML = "<option value=''>Cihaz bulunamadı</option>";
    } catch (err) {
        console.warn("getDevices error:", err);
        micSelect.innerHTML = "<option value=''>Yüklenemedi</option>";
        spkSelect.innerHTML = "<option value=''>Yüklenemedi</option>";
    }
}

window.changeDevice = async function(type) {
    const micSelect = document.getElementById("micSelect");
    const spkSelect = document.getElementById("speakerSelect");
    if (!micSelect || !spkSelect) return;
    const deviceId = type === "mic" ? micSelect.value : spkSelect.value;
    if (!deviceId) return;
    try {
        if (type === "mic" && localAudioTrack) {
            await localAudioTrack.setDevice(deviceId);
            showNotification("Mikrofon değiştirildi");
        } else if (type === "speaker") {
            let n = 0;
            for (const user of client.remoteUsers || []) {
                if (user.audioTrack) {
                    try {
                        await user.audioTrack.setPlaybackDevice(deviceId);
                        n++;
                    } catch (e) { console.warn("setPlaybackDevice:", e); }
                }
            }
            if (n > 0) showNotification("Hoparlör güncellendi");
        }
    } catch (err) {
        console.error("Cihaz değişmedi:", err);
        showNotification("Cihaz değiştirilemedi", "error");
    }
};

window.changeAudioQuality = () => showNotification("Ses kalitesi ayarlandı");
window.playTestSound = () => {
    try {
        const a = new Audio("https://www.soundjay.com/buttons/beep-01a.mp3");
        a.volume = 0.3;
        a.play().catch(() => {});
    } catch (e) {}
};
window.saveAudioSettings = () => {
    closeSettings();
    showNotification("Ayarlar kaydedildi");
};

window.togglePanel = function(panel) {
    const rightPanel = document.getElementById("rightPanel");
    const leftPanel = document.getElementById("leftPanel");
    if (!rightPanel || !leftPanel) return;
    if (panel === "chat") {
        const isOpen = rightPanel.classList.contains("active");
        rightPanel.classList.toggle("active", !isOpen);
        leftPanel.classList.remove("active");
    } else if (panel === "users") {
        const isOpen = leftPanel.classList.contains("active");
        leftPanel.classList.toggle("active", !isOpen);
        rightPanel.classList.remove("active");
    }
};

/** Çarpı veya backdrop tıklanınca paneli kapat (mobil + PC). */
window.closePanel = function(which) {
    const rightPanel = document.getElementById("rightPanel");
    const leftPanel = document.getElementById("leftPanel");
    if (!rightPanel || !leftPanel) return;
    if (which === "chat") {
        rightPanel.classList.remove("active");
    } else if (which === "users") {
        leftPanel.classList.remove("active");
    } else {
        leftPanel.classList.remove("active");
        rightPanel.classList.remove("active");
    }
};

// ============================================
// HELPERS
// ============================================
function showError(msg) {
    showNotification(msg, "error");
}

function showSuccess(msg) {
    showNotification(msg, "success");
}

function updateBubbleStage(html) {
    const bubbleStage = document.getElementById("bubbleStage");
    if (bubbleStage) {
        if (html === "") {
            // Clear loading message
            const p = bubbleStage.querySelector("p");
            if (p) p.style.display = "none";
        } else {
            // Show error or status message
            bubbleStage.innerHTML = html;
        }
    }
}

function updateRoomBellIcon() {
    const bellIcon = document.getElementById("roomBellIcon");
    const bellIconOff = document.getElementById("roomBellIconOff");
    const bellBtn = document.getElementById("roomBellBtn");
    
    if (!bellBtn) return;
    
    const notificationsEnabled = localStorage.getItem("roomNotifications") !== "false";
    if (notificationsEnabled) {
        if (bellIcon) bellIcon.style.display = "inline";
        if (bellIconOff) bellIconOff.style.display = "none";
    } else {
        if (bellIcon) bellIcon.style.display = "none";
        if (bellIconOff) bellIconOff.style.display = "inline";
    }
}

function showNotification(msg, type = "success") {
    const div = document.createElement("div");
    div.className = `room-notification notification-${type}`;
    div.innerHTML = `<i class="fa-solid ${type === "error" ? "fa-exclamation-circle" : "fa-check-circle"}"></i> ${msg}`;
    document.body.appendChild(div);
    
    setTimeout(() => div.classList.add("show"), 10);
    setTimeout(() => {
        div.classList.remove("show");
        setTimeout(() => div.remove(), 300);
    }, 3000);
}

// GLOBALS for video
let screenShare = false;
let screenVideoTrack = null;
let screenAudioTrack = null;
let cameraShare = false;
let cameraVideoTrack = null;
let videoTracks = new Map(); // uid -> { element, type }
let currentVideoMode = null; // 'camera' | 'screen' | null

function showVideoStage() {
    const videoStage = document.getElementById("videoStage");
    const bubbleStage = document.getElementById("bubbleStage");
    if (videoStage) {
        videoStage.style.display = "grid";
        // Grid layout based on video count
        const videoCount = videoStage.querySelectorAll(".video-container").length;
        if (videoCount === 1) {
            videoStage.style.gridTemplateColumns = "1fr";
        } else if (videoCount === 2) {
            videoStage.style.gridTemplateColumns = "repeat(2, 1fr)";
        } else {
            videoStage.style.gridTemplateColumns = "repeat(auto-fit, minmax(350px, 1fr))";
        }
    }
    if (bubbleStage) bubbleStage.style.display = "none";
}

function showBubbleStage() {
    const videoStage = document.getElementById("videoStage");
    const bubbleStage = document.getElementById("bubbleStage");
    if (videoStage) videoStage.style.display = "none";
    if (bubbleStage) bubbleStage.style.display = "grid";
}

// ==========================================
// BİNGO: DOĞRU VİDEO OLUŞTURMA MANTIĞI
// ==========================================
function attachVideoTrack(track, uid, name, type = "camera") {
    return new Promise((resolve, reject) => {
        try {
            if (!track) return reject(new Error("Video track yok"));
            
            showVideoStage(); // HTML'deki videoStage'i görünür yap

            const videoStage = document.getElementById("videoStage");
            const existing = document.getElementById(`video-${uid}`);
            if (existing) existing.remove();

            // 1. Agora için bir DIV oluşturuyoruz (KESİNLİKLE <video> değil!)
            const container = document.createElement("div");
            container.className = `video-container ${type}-share`;
            container.id = `video-${uid}`;
            
            // Konteynerin boyutlarını ve stilini ayarlıyoruz
            container.style.width = "100%";
            container.style.height = "100%";
            container.style.minHeight = "300px";
            container.style.position = "relative";
            container.style.borderRadius = "15px";
            container.style.overflow = "hidden";
            container.style.background = "#050505";

            // 2. İsim Etiketi
            const label = document.createElement("div");
            label.innerHTML = `<i class="fa-solid ${type === "screen" ? "fa-desktop" : "fa-camera"}"></i> <span>${name}</span>`;
            label.style.position = "absolute";
            label.style.bottom = "15px";
            label.style.left = "15px";
            label.style.zIndex = "10";
            label.style.background = "rgba(0,0,0,0.7)";
            label.style.backdropFilter = "blur(5px)";
            label.style.padding = "6px 12px";
            label.style.borderRadius = "8px";
            label.style.color = "#fff";

            container.appendChild(label);
            videoStage.appendChild(container);

            // 3. Agora'ya DIV'i veriyoruz, o kendi <video> etiketini içine kuruyor!
            track.play(container);
            
            videoTracks.set(uid, { element: container, track, type });
            currentVideoMode = type;
            console.log(`✅ Görüntü Ekranda: ${uid} (${type})`);
            resolve();
            
        } catch (err) {
            console.error("❌ Video basma hatası:", err);
            reject(err);
        }
    });
}

function removeVideoTrack(uid) {
    const container = document.getElementById(`video-${uid}`);
    if (container) {
        console.log(`🗑️ Removing video: ${uid}`);
        // Fade out effect
        container.style.opacity = "0.5";
        container.style.transition = "opacity 0.3s";
        
        setTimeout(() => {
            container.remove();
            videoTracks.delete(uid);
            
            // If no videos left, show bubbles again
            if (videoTracks.size === 0) {
                console.log("📷 No videos left, showing bubbles");
                showBubbleStage();
                currentVideoMode = null;
            }
        }, 300);
    }
}

function clearAllVideos() {
    console.log("🗑️ Clearing all videos...");
    videoTracks.forEach(({ element }) => element.remove());
    videoTracks.clear();
    showBubbleStage();
    currentVideoMode = null;
}

// ==========================================
// SCREEN SHARE
// ==========================================
window.startScreenShare = async function() {
    try {
        if (screenShare) {
            await stopScreenShare();
            return;
        }
        
        showNotification("Ekran paylaşımı başlatılıyor...");
        
        try {
            screenAudioTrack = await AgoraRTC.createScreenAudioTrack();
            screenVideoTrack = await AgoraRTC.createScreenVideoTrack();
        } catch (err) {
            console.warn("Screen audio unavailable:", err);
            screenVideoTrack = await AgoraRTC.createScreenVideoTrack();
        }
        
        if (localAudioTrack) {
            await client.unpublish([localAudioTrack]);
            await localAudioTrack.close();
        }
        
        const tracksToPub = screenVideoTrack ? [screenVideoTrack] : [];
        if (screenAudioTrack) tracksToPub.push(screenAudioTrack);
        
        await client.publish(tracksToPub);
        
        screenShare = true;
        const btn = document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.add("hangup");
            btn.innerHTML = '<i class="fa-solid fa-share-alt"></i>';
        }
        
        if (screenVideoTrack) {
            try {
                await attachVideoTrack(screenVideoTrack, `screen-${currentUser.uid}`, currentUser.displayName + " - Ekran", "screen");
            } catch (err) {
                console.error("Ekran görüntülenemedi:", err);
                showNotification("Ekran görüntülenemedi: " + err.message, "error");
            }
        }
        
        showNotification("Ekranın paylaşılıyor ✨");
        
        screenVideoTrack.on("ended", async () => {
            await stopScreenShare();
        });
        
    } catch (err) {
        console.error("Screen share error:", err);
        showNotification("Ekran paylaşımı başlatılamadı: " + err.message, "error");
        screenShare = false;
    }
}

window.stopScreenShare = async function() {
    try {
        console.log("🔴 Stopping screen share...");
        
        if (screenAudioTrack) {
            try {
                await client.unpublish([screenAudioTrack]);
                screenAudioTrack.stop();
                screenAudioTrack.close?.();
                screenAudioTrack = null;
            } catch (err) {
                console.warn("Screen audio stop error:", err);
            }
        }
        
        if (screenVideoTrack) {
            try {
                await client.unpublish([screenVideoTrack]);
                screenVideoTrack.stop();
                screenVideoTrack.close?.();
                screenVideoTrack = null;
            } catch (err) {
                console.warn("Screen video stop error:", err);
            }
        }
        
        try {
            localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
                encoderConfig: {
                    sampleRate: 48000,
                    stereo: true,
                    channel: 2,
                    bitrate: 128
                },
                AEC: true,
                ANS: true,
                AGC: true,
                noiseSuppression: true
            });
            
            await client.publish([localAudioTrack]);
            console.log("✅ Microphone republished");
        } catch (err) {
            console.error("Mic restore error:", err);
            showNotification("Mikrofon geri açılamadı", "error");
        }
        
        screenShare = false;
        const btn = document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.remove("hangup");
            btn.innerHTML = '<i class="fa-solid fa-desktop"></i>';
        }
        
        removeVideoTrack(`screen-${currentUser.uid}`);
        showNotification("Ekran paylaşmayı durdurdu");
        
    } catch (err) {
        console.error("Screen share stop error:", err);
        showNotification("Ekran paylaşmayı durdurma hatası", "error");
    }
}

// ==========================================
// SCREEN SHARE (DÜZELTİLDİ - SES KESMEZ)
// ==========================================
window.startScreenShare = async function() {
    try {
        if (screenShare) {
            await stopScreenShare();
            return;
        }
        
        showNotification("Ekran paylaşımı başlatılıyor...");
        
        // 1. Ekran videosunu ve (varsa) sistem sesini al
        try {
            screenAudioTrack = await AgoraRTC.createScreenAudioTrack();
            screenVideoTrack = await AgoraRTC.createScreenVideoTrack();
        } catch (err) {
            console.warn("Sistem sesi alınamadı, sadece görüntü alınıyor:", err);
            screenVideoTrack = await AgoraRTC.createScreenVideoTrack();
        }
        
        // 2. MİKROFONU KAPATMIYORUZ! Sadece yeni ekran görüntülerini Agora'ya ekliyoruz (publish)
        const tracksToPub = screenVideoTrack ? [screenVideoTrack] : [];
        if (screenAudioTrack) tracksToPub.push(screenAudioTrack);
        
        await client.publish(tracksToPub);
        screenShare = true;
        
        const btn = document.getElementById("screenBtn") || document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.add("hangup");
            btn.innerHTML = '<i class="fa-solid fa-share-alt"></i>';
        }
        
        // 3. Kendi ekranımızı "videoStage" alanına basıyoruz
        if (screenVideoTrack) {
            await attachVideoTrack(screenVideoTrack, `screen-${currentUser.uid}`, currentUser.displayName + " - Ekran", "screen");
        }
        
        showNotification("Ekranın paylaşılıyor ✨");
        
        // Kullanıcı tarayıcıdan "Paylaşmayı Durdur"a basarsa
        screenVideoTrack.on("ended", async () => {
            await stopScreenShare();
        });
        
    } catch (err) {
        console.error("Screen share error:", err);
        showNotification("Ekran paylaşımı başlatılamadı!", "error");
        screenShare = false;
    }
}

window.stopScreenShare = async function() {
    try {
        if (screenAudioTrack) {
            await client.unpublish([screenAudioTrack]);
            screenAudioTrack.stop();
            screenAudioTrack.close?.();
            screenAudioTrack = null;
        }
        
        if (screenVideoTrack) {
            await client.unpublish([screenVideoTrack]);
            screenVideoTrack.stop();
            screenVideoTrack.close?.();
            screenVideoTrack = null;
        }
        
        screenShare = false;
        const btn = document.getElementById("screenBtn") || document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.remove("hangup");
            btn.innerHTML = '<i class="fa-solid fa-desktop"></i>';
        }
        
        removeVideoTrack(`screen-${currentUser.uid}`);
        showNotification("Ekran paylaşımı durduruldu");
        
    } catch (err) {
        console.error("Screen share stop error:", err);
    }
}

// ==========================================
// CAMERA SHARE (DÜZELTİLDİ - SES KESMEZ)
// ==========================================
window.startCameraShare = async function() {
    try {
        if (cameraShare) {
            await stopCameraShare();
            return;
        }
        
        showNotification("Kamera başlatılıyor...");
        
        cameraVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        
        // MİKROFONU ELLEMİYORUZ, sadece kamerayı yayına ekliyoruz
        await client.publish([cameraVideoTrack]);
        cameraShare = true;
        
        const btn = document.getElementById("camBtn") || document.querySelector('button[title="Kamera"]');
        if (btn) {
            btn.classList.add("hangup");
            btn.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
        }
        
        // Kameramızı ekrana bas
        await attachVideoTrack(cameraVideoTrack, currentUser.uid, currentUser.displayName || "Kamera", "camera");
        showNotification("Kamera yayında 📹");
        
    } catch (err) {
        console.error("Camera share error:", err);
        showNotification("Kamera açılamadı!", "error");
        cameraShare = false;
    }
}

window.stopCameraShare = async function() {
    try {
        if (cameraVideoTrack) {
            await client.unpublish([cameraVideoTrack]);
            cameraVideoTrack.stop();
            cameraVideoTrack.close?.();
            cameraVideoTrack = null;
        }
        
        cameraShare = false;
        const btn = document.getElementById("camBtn") || document.querySelector('button[title="Kamera"]');
        if (btn) {
            btn.classList.remove("hangup");
            btn.innerHTML = '<i class="fa-solid fa-video"></i>';
        }
        
        removeVideoTrack(currentUser.uid);
        showNotification("Kamera kapatıldı");
        
    } catch (err) {
        console.error("Camera stop error:", err);
    }
}

// Desktop panel toggle
function initDesktopPanelToggle() {
    const isDesktop = window.innerWidth >= 1024;
    
    if (isDesktop) {
        const usersToggle = document.getElementById("desktopUsersToggle");
        const chatToggle = document.getElementById("desktopChatToggle");
        
        if (usersToggle) usersToggle.style.display = "flex";
        if (chatToggle) chatToggle.style.display = "flex";
        
        console.log("✅ Desktop panel toggles enabled");
    }
}

window.addEventListener("resize", initDesktopPanelToggle);
window.addEventListener("load", initDesktopPanelToggle);

// ============================================
// BUBBLE MANAGEMENT
// ============================================
function addBubble(uid, name, photo, isLocal, isMuted) {
    if (document.getElementById(`bubble-${uid}`)) return;
    
    const stage = document.getElementById("bubbleStage");
    const list = document.getElementById("userListContainer");

    stage.insertAdjacentHTML('beforeend', `
        <div class="user-bubble bubble-enter" id="bubble-${uid}">
            <img src="${photo || 'assets/img/default-avatar.png'}" class="bubble-img">
            <span class="bubble-name">${name}</span>
        </div>`);

    const micClass = isMuted ? "fa-microphone-slash muted" : "fa-microphone active";
    list.insertAdjacentHTML('beforeend', `
        <div class="user-card" id="list-user-${uid}">
            <div class="avatar-wrapper">
                <img src="${photo || 'assets/img/default-avatar.png'}">
                <div class="audio-ring"></div>
            </div>
            <div class="user-info">
                <span class="username">${name} ${isLocal ? '(Sen)' : ''}</span>
                <span class="status">Bağlı</span>
            </div>
            <i class="fa-solid ${micClass} mic-icon" id="mic-icon-${uid}"></i>
        </div>`);
    updateUserCount();
}

function removeBubble(uid) {
    document.getElementById(`bubble-${uid}`)?.remove();
    document.getElementById(`list-user-${uid}`)?.remove();
    updateUserCount();
}

function updateUserCount() {
    const c = document.getElementById("userCount");
    const list = document.getElementById("userListContainer");
    if(c && list) c.innerText = list.children.length;
}

// Test commands for console
window.testDiagnostics = () => {
    console.log("📊 DIAGNOSTICS:");
    console.log("User:", currentUser?.uid);
    console.log("Channel:", CHANNEL_NAME);
    console.log("Agora State:", client?.connectionState);
    console.log("Remote Users:", client?.remoteUsers?.length || 0);
    console.log("Audio Track:", localAudioTrack ? "✅" : "❌");
};
