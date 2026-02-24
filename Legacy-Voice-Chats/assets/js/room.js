import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    doc, updateDoc, collection, onSnapshot, query, orderBy, 
    serverTimestamp, getDoc, addDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const AGORA_APP_ID = ""; 
// --- GLOBALLER ---
let client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" }); // VP8 for multitrack video support
let localAudioTrack;
let screenShare = false;
let screenAudioTrack = null;
let screenVideoTrack = null;
let cameraShare = false;
let cameraVideoTrack = null;
let currentUser = null;
let CHANNEL_NAME = "";
let currentRoomName = "";
let audioContext;
let micSourceNode;
let gainNode;
let analyserNode;
let destinationNode;
let isMicMuted = false;
let isAudioMuted = false; 
let isJoining = false; 
let lastUserIds = new Set(); // Kimin çıkıp girdiğini anlamak için
let connectionQuality = "excellent"; // Network quality
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Oda Özellikleri
let roomFeatures = {
    video: true,
    screenShare: true,
    text: true
};

// --- BİLDİRİM SESLERİ ---
const sounds = {
    msg: new Audio("https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3"),
    join: new Audio("https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3"),
    leave: new Audio("https://assets.mixkit.co/active_storage/sfx/2359/2359-preview.mp3")
};
Object.values(sounds).forEach(s => s.volume = 0.4);

// --- VİDEO DISPLAY ---
let videoTracks = new Map(); // uid -> { element, type: 'camera' | 'screen' }
let currentVideoMode = null; // 'camera' | 'screen' | null

// ==========================================
// 1. BAŞLANGIÇ VE AUTH
// ==========================================
onAuthStateChanged(auth, async (user) => {
    if (user && !isJoining) {
        isJoining = true; 
        currentUser = user;
        CHANNEL_NAME = localStorage.getItem("currentRoomId");
        currentRoomName = localStorage.getItem("currentRoomName");

        if (!CHANNEL_NAME) {
            window.location.href = "dashboard.html";
            return;
        }

        document.getElementById("roomHeader").innerHTML = `<i class="fa-solid fa-hashtag"></i> ${currentRoomName}`;
        
        // Connection timeout protection (45 seconds - allows slower networks)
        const connectionPromise = joinRoom()
            .then(() => {
                loadRoomFeatures();
                initChat(); 
                initUserSync(); 
                window.addEventListener("beforeunload", handleCleanup);
                showNotification("✨ Bölgeye başarıyla bağlanıldı!");
                logEvent("connection", "Room join completed");
            })
            .catch((err) => {
                console.error("❌ Oda katılım hatası:", err);
                isJoining = false;
                throw err;
            });
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => {
                isJoining = false;
                reject(new Error("Bağlantı zaman aşımına uğradı (45sn). Sayfayı yenileyip dene."));
            }, 45000)
        );
        
        try {
            // Race: whichever completes first
            await Promise.race([connectionPromise, timeoutPromise]);
        } catch (err) {
            console.error("⏱️ Timeout veya bağlantı hatası:", err);
            showNotification(`${err.message}`, "error");
            logEvent("error", "Connection timeout or error", { error: err.message });
            
            const stage = document.getElementById("bubbleStage");
            if (stage) {
                stage.innerHTML = `<p style="color: #ff6b6b; text-align: center; padding: 20px;">
                    ❌ ${err.message}<br/>
                    <small style="color: rgba(255,255,255,0.5)">Sayfayı yenile (F5)</small>
                </p>`;
            }
            isJoining = false;
        }
    } else if (!user) {
        window.location.href = "index.html";
    }
});

// ==========================================
// 2. KULLANICI SENKRONİZASYONU (GİRİŞ/ÇIKIŞ SESLİ)
// ==========================================
async function loadRoomFeatures() {
    try {
        const roomRef = doc(db, "rooms", CHANNEL_NAME);
        const roomSnap = await getDoc(roomRef);
        
        if (roomSnap.exists()) {
            const features = roomSnap.data().features || { video: true, screenShare: true, text: true };
            roomFeatures = features;
            
            // Butonları kontrol et
            updateFeatureButtons();
            updateButtonStates();
            
            console.log("✅ Oda özellikleri yüklendi:", roomFeatures);
            logEvent("connection", "Room features loaded", { features: roomFeatures });
        }
    } catch (err) {
        console.error("Oda özellikleri yüklenirken hata:", err);
        logEvent("error", "Failed to load room features", { error: err.message });
    }
}

function updateFeatureButtons() {
    const camerBtn = document.querySelector('button[title="Kamera Paylaş"]');
    const screenBtn = document.querySelector('button[title="Ekran Paylaş"]');
    
    // Kamera butonunu devre dışı bırak/etkinleştir
    if (camerBtn) {
        if (!roomFeatures.video) {
            camerBtn.disabled = true;
            camerBtn.style.opacity = "0.5";
            camerBtn.style.cursor = "not-allowed";
            camerBtn.title = "Kamera bu bölgede kapalı";
        } else {
            camerBtn.disabled = false;
            camerBtn.style.opacity = "1";
            camerBtn.style.cursor = "pointer";
            camerBtn.title = "Kamera Paylaş";
        }
    }
    
    // Ekran paylaşım butonunu devre dışı bırak/etkinleştir
    if (screenBtn) {
        if (!roomFeatures.screenShare) {
            screenBtn.disabled = true;
            screenBtn.style.opacity = "0.5";
            screenBtn.style.cursor = "not-allowed";
            screenBtn.title = "Ekran paylaşımı bu bölgede kapalı";
        } else {
            screenBtn.disabled = false;
            screenBtn.style.opacity = "1";
            screenBtn.style.cursor = "pointer";
            screenBtn.title = "Ekran Paylaş";
        }
    }
    
    // Chat özelliği kapalı ise mesaj girdisini gizle
    const chatContainer = document.getElementById("chatContainer");
    const msgInput = document.getElementById("msgInput");
    const sendBtn = document.getElementById("sendBtn");
    
    if (!roomFeatures.text) {
        if (chatContainer) chatContainer.style.display = "none";
        if (msgInput) msgInput.style.display = "none";
        if (sendBtn) sendBtn.style.display = "none";
    }
}

// ==========================================
// 3. KULLANICI SENKRONİZASYONU (GİRİŞ/ÇIKIŞ SESLİ)
// ==========================================
function initUserSync() {
    const roomRef = doc(db, "rooms", CHANNEL_NAME);
    let lastUpdate = 0;
    
    onSnapshot(roomRef, (docSnap) => {
        if (!docSnap.exists()) {
            console.warn("⚠️ Oda Firestore'da yok:", CHANNEL_NAME);
            return;
        }
        
        const data = docSnap.data();
        const users = data.users || []; 
        const currentUids = new Set();
        const stage = document.getElementById("bubbleStage");

        // Loading mesajını kaldır
        if(stage.innerHTML.includes("giriş yapılıyor")) {
            stage.innerHTML = "";
        }

        // Firestore users'ı oku
        users.forEach(u => {
            currentUids.add(u.uid);
            const isLocal = (u.uid === currentUser.uid);

            // Yeni Biri Girdiyse (Join Sesi + Bubble)
            if (!lastUserIds.has(u.uid)) {
                if (!isLocal && lastUserIds.size > 0) {
                    console.log(`🎤 Yeni user girdi: ${u.name} (${u.uid})`);
                    if (!isAudioMuted) sounds.join.play().catch(() => {});
                }
                addBubble(u.uid, u.name, u.photo, isLocal, u.isMuted);
            } else {
                // User zaten var, sadece mute state'ini güncelle
                updateUserUIState(u.uid, u.isMuted);
            }
        });

        // Biri Çıktıysa (Leave Sesi)
        lastUserIds.forEach(oldId => {
            if (!currentUids.has(oldId)) {
                const userName = document.querySelector(`[id="bubble-${oldId}"] .bubble-name`)?.innerText || "??";
                console.log(`📴 User çıktı: ${userName} (${oldId})`);
                if (!isAudioMuted) sounds.leave.play().catch(() => {});
                removeBubble(oldId);
            }
        });

        lastUserIds = new Set(currentUids);
        
        // Agora remote users ile Firestore'u karşılaştır
        console.log(`👥 Firestore: ${users.length} users | Agora: ${client.remoteUsers.length + 1} (local+ remote)`);
        logEvent("connection", "User sync updated", { 
            firestoreCount: users.length, 
            agoraRemote: client.remoteUsers.length 
        });
    }, (err) => {
        console.error("Firestore listen hatası:", err);
        logEvent("error", "Firestore sync error", { error: err.message });
    });
}

function updateUserUIState(uid, isMuted) {
    const micIcon = document.getElementById(`mic-icon-${uid}`);
    if (micIcon) {
        micIcon.className = isMuted ? 
            "fa-solid fa-microphone-slash mic-icon muted" : 
            "fa-solid fa-microphone mic-icon active";
    }
}

function setupAdvancedAudio() {
    return new Promise((resolve, reject) => {
        try {
            const mediaStreamTrack = localAudioTrack.getMediaStreamTrack();
            const stream = new MediaStream([mediaStreamTrack]);
            
            micSourceNode = audioContext.createMediaStreamSource(stream);
            gainNode = audioContext.createGain();
            analyserNode = audioContext.createAnalyser();
            destinationNode = audioContext.createMediaStreamDestination();

            // Chain: Mic -> Gain -> Analyser -> Destination
            micSourceNode.connect(gainNode);
            gainNode.connect(analyserNode);
            analyserNode.connect(destinationNode);
            
            // Set default gain
            gainNode.gain.value = 1.0;
            
            // Create custom track from processed audio
            const processedAudioTrack = destinationNode.stream.getAudioTracks()[0];
            
            if (processedAudioTrack) {
                const finalTrack = AgoraRTC.createCustomAudioTrack({
                    mediaStreamTrack: processedAudioTrack
                });
                
                client.publish([finalTrack]).then(() => {
                    console.log("✅ Advanced audio setup successful");
                    logEvent("audio", "Advanced audio setup successful");
                    startMicMeter();
                    resolve();
                }).catch((err) => {
                    console.warn("Custom track publish failed, using standard track:", err);
                    client.publish([localAudioTrack]).then(() => {
                        startMicMeter();
                        resolve();
                    }).catch(reject);
                });
            } else {
                // Fallback
                client.publish([localAudioTrack]).then(() => {
                    console.log("✅ Standard audio published (no processing)");
                    startMicMeter();
                    resolve();
                }).catch(reject);
            }
        } catch (err) {
            console.error("Advanced audio setup error:", err);
            logEvent("error", "Advanced audio setup failed", { error: err.message });
            // Fallback to standard audio
            client.publish([localAudioTrack]).then(() => {
                startMicMeter();
                resolve();
            }).catch(reject);
        }
    });
}

// ==========================================
// 3. AGORA (SES VE YEŞİL IŞIK)
// ==========================================
// room.js içindeki joinRoom ve setup kısımlarını bu modern haliye güncelle

async function joinRoom() {
    try {
        // Agora SDK kontrolü
        if (typeof AgoraRTC === 'undefined') {
            throw new Error("Agora SDK yüklenmedi. Sayfayı yenileyip dene.");
        }
        
        console.log("Odaya katılım başlıyor:", CHANNEL_NAME);
        logEvent("connection", "Attempting to join room", { channelName: CHANNEL_NAME });
        
        await addToRoomList(false); 
        console.log("Kullanıcı liste eklendi");
        
        await client.join(AGORA_APP_ID, CHANNEL_NAME, null, currentUser.uid);
        console.log("Agora'ya başarıyla katıldı");
        logEvent("connection", "Successfully joined Agora channel");

        // SES MOTORUNU HAZIRLA (Ama henüz başlatma)
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // 1. MİKROFONU OLUŞTUR (STEREO, High Quality) + KAMERA READY
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: {
                sampleRate: 48000, // 48kHz professional quality
                stereo: true,      // Stereo output
                channel: 2,
                bitrate: 128       // 128kbps high quality
            },
            AEC: true,             // Echo cancellation ON
            ANS: true,             // Noise suppression ON
            AGC: true,             // Auto gain control ON
            noiseSuppression: true
        });
        
        // Kamera Track'i pre-load et (başlatmadan)
        console.log("📷 Kamera hardware hazırlanıyor...");

        // 2. GELİŞMİŞ SES AYARLARINI BAĞLA (Publish burada yapılacak)
        console.log("🔄 Advanced audio setup başlıyor...");
        try {
            await setupAdvancedAudio();
            console.log("✅ Advanced audio setup tamamlandı");
        } catch (err) {
            console.error("⚠️ Advanced audio setup failed, fallback:", err);
            // Fallback already handled in setupAdvancedAudio()
        }

        // ===== AGORA EVENT LISTENERS =====
        console.log("🎙️ Agora event listeners kuruluyor...");
        setupAgoraEventHandlers();
        
        client.enableAudioVolumeIndicator();
        getDevices();
        
        // MEVCUT REMOTE USERS'I SUBSCRIBE ET (ÖNeMLİ!)
        // Bu, sonradan katılanların sessiz kalmayı önler
        console.log("Mevcut remote users sayısı:", client.remoteUsers.length);
        for (let remoteUser of client.remoteUsers) {
            try {
                await client.subscribe(remoteUser, "audio");
                if (remoteUser.audioTrack && !isAudioMuted) {
                    remoteUser.audioTrack.play();
                    console.log("Existing user subscribed:", remoteUser.uid);
                }
            } catch (err) {
                console.warn("Failed to subscribe to existing user:", remoteUser.uid, err);
            }
        }

        // MOBİL FİX: Ekrana ilk dokunuşta her şeyi uyandır
        document.body.addEventListener('click', async () => {
            if (audioContext && audioContext.state === 'suspended') {
                await audioContext.resume();
                console.log("Ses motoru Lordun emriyle uyandı! 🐉");
            }
        }, { once: true });

    } catch (e) { 
        console.error("❌ Oda bağlantısı hatası:", e);
        logEvent("error", "Failed to join room", { error: e.message || e.code });
        
        // Bubble'dan loading mesajı kaldır
        const stage = document.getElementById("bubbleStage");
        if (stage) stage.innerHTML = "";
        
        if (e.code === "PERMISSION_DENIED" || e.message?.includes("permission")) {
            showNotification("🔒 Mikrofon izni şart lordum! İzin ver.", "error");
            alert("Lütfen mikrofon izni ver");
        } else if (e.message?.includes("Room not found")) {
            showNotification("❌ Bu oda bulunamadı. Dashboard'a dön.", "error");
            setTimeout(() => window.location.href = "dashboard.html", 2000);
        } else if (e.message?.includes("SDK")) {
            showNotification("⚠️ Agora SDK yüklenmedi. Sayfayı yenileyip dene.", "error");
            setTimeout(() => location.reload(), 2000);
        } else {
            showNotification(`⚠️ Bağlantı hatası: ${e.message || e.code}`, "error");
            setTimeout(() => location.reload(), 3000);
        }
        
        isJoining = false; // Reset flag
        throw e;
    }
}

// ===== AGORA EVENT HANDLERS (DETAYLI) =====
function setupAgoraEventHandlers() {
    
    // YENİ USER PUBLISH ETTIĞINDE (KAMERA/EKRAN)
    client.on("user-published", async (user, mediaType) => {
        console.log(`[USER-PUBLISHED] ${user.uid} -> ${mediaType}`);
        logEvent("connection", "User published", { uid: user.uid, mediaType });
        
        try {
            await client.subscribe(user, mediaType);
            
            if (mediaType === "audio") {
                if (!isAudioMuted && user.audioTrack) {
                    user.audioTrack.play();
                    console.log(`🔊 Audio playing for user ${user.uid}`);
                    logEvent("audio", "Remote audio playing", { uid: user.uid });
                }
            } else if (mediaType === "video") {
                console.log(`🎥 Subscribing to video: ${user.uid}`);
                // Video track'i attach etmek için remote user'ı takip et
                if (user.videoTrack) {
                    console.log(`✅ Video track available for ${user.uid}`);
                    // Not: Remote video'lar custom UI ile gösteriliyorsa handleVideoSubscription() çağırılmalı
                }
            }
        } catch (err) {
            console.error("❌ Subscribe error:", err);
            logEvent("error", "Failed to subscribe to user", { uid: user.uid, mediaType, error: err.message });
        }
    });

    // USER UNPUBLISH ETTIĞINDE (MİKROFON/KAMERA KAPATTı)
    client.on("user-unpublished", (user, mediaType) => {
        console.log(`[USER-UNPUBLISHED] ${user.uid} -> ${mediaType}`);
        logEvent("connection", "User unpublished", { uid: user.uid, mediaType });
        
        if (mediaType === "audio") {
            try {
                if (user.audioTrack) {
                    user.audioTrack.stop();
                    console.log(`🔇 Audio stopped for ${user.uid}`);
                    logEvent("audio", "Remote audio stopped", { uid: user.uid });
                }
            } catch (err) {
                console.warn("Stop audio error:", err);
            }
        } else if (mediaType === "video") {
            try {
                if (user.videoTrack) {
                    user.videoTrack.stop();
                    console.log(`📹 Video stopped for ${user.uid}`);
                }
                // Video container'ı kaldır
                removeVideoTrack(user.uid);
            } catch (err) {
                console.warn("Stop video error:", err);
            }
        }
    });

    // USER BAĞLANTIDAN ÇIKTI (ODADAN AYRILDI)
    client.on("user-left", (user) => {
        console.log(`[USER-LEFT] ${user.uid} - Odayı terk etti`);
        logEvent("connection", "User left channel", { uid: user.uid });
        
        // Tüm video track'leri kaldır
        removeVideoTrack(user.uid);
    });

    // SES SEVİYESİ İNDİKATÖRÜ (SPEAKING ANIMATION)
    client.on("volume-indicator", (volumes) => {
        document.querySelectorAll('.user-bubble, .user-card').forEach(el => el.classList.remove("speaking"));
        volumes.forEach((v) => {
            const targetId = (v.uid === 0 || v.uid === currentUser.uid) ? currentUser.uid : v.uid;
            if (v.level > 5) {
                document.getElementById(`bubble-${targetId}`)?.classList.add("speaking");
                document.getElementById(`list-user-${targetId}`)?.classList.add("speaking");
            }
        });
    });

    // AĞ KALİTESİ İZLEME
    client.on("network-quality", (quality) => {
        updateNetworkQuality(quality);
    });

    // BAĞLANTI DURUMU DEĞİŞTİ (DISCONNECT/RECONNECT)
    client.on("connection-state-change", (curState, prevState, reason) => {
        console.log(`[CONNECTION-STATE] ${prevState} → ${curState} | Reason: ${reason}`);
        logEvent("connection", "Connection state changed", { from: prevState, to: curState, reason });
        
        if (curState === "DISCONNECTED") {
            showNotification("❌ Bağlantı kesildi!", "error");
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                console.log(`🔄 Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
                showNotification("Bağlantı yeniden kuruluyor...");
            } else {
                showNotification("Bağlantı kurulamadı. Sayfayı yenileyip dene.", "error");
            }
        } else if (curState === "CONNECTED") {
            reconnectAttempts = 0;
            showNotification("✨ Bölgeye bağlanıldı!");
            logEvent("connection", "Successfully reconnected to channel");
        }
    });
}

function startMicMeter() {
    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

    function update() {
        analyserNode.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        let avg = sum / dataArray.length;
        let percent = (avg / 255) * 100;

        const meter = document.getElementById("micLevel");
        if (meter) meter.style.width = percent + "%";

        requestAnimationFrame(update);
    }
    update();
}

document.getElementById("speakerVolume")?.addEventListener("input", (e) => {
    const vol = e.target.value / 100;

    client.remoteUsers.forEach(user => {
        if (user.audioTrack) {
            user.audioTrack.setVolume(vol * 100);
        }
    });
});

/* ================= NETWORK QUALITY MONITOR ================= */
function updateNetworkQuality(quality) {
    const qualityBar = document.querySelector(".quality-bars");
    const qualityText = document.getElementById("qualityText");
    
    if (!qualityBar || !qualityText) return;

    const qualityLevels = {
        0: { text: "Bilinmiyor", color: "#888", bars: 0 },
        1: { text: "Mükemmel", color: "#00ff88", bars: 3 },
        2: { text: "İyi", color: "#ffff00", bars: 2 },
        3: { text: "Zayıf", color: "#ff9500", bars: 1 },
        4: { text: "Kötü", color: "#ff4d4d", bars: 0 }
    };

    const level = qualityLevels[quality.downlinkNetworkQuality] || qualityLevels[0];
    connectionQuality = level.text;
    qualityText.textContent = level.text;
    qualityText.style.color = level.color;

    // Barları güncelle
    const bars = qualityBar.querySelectorAll(".quality-bar");
    bars.forEach((bar, index) => {
        if (index < level.bars) {
            bar.style.backgroundColor = level.color;
            bar.style.opacity = "1";
        } else {
            bar.style.opacity = "0.3";
            bar.style.backgroundColor = "#666";
        }
    });
}

document.getElementById("noiseSuppression")?.addEventListener("change", async (e) => {
    if (!localAudioTrack || screenShare) return;

    try {
        await localAudioTrack.setEnabled(false);

        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: {
                sampleRate: 48000,
                stereo: true,
                channel: 2,
                bitrate: 128
            },
            AEC: true,
            ANS: e.target.checked,
            AGC: document.getElementById("autoGain").checked,
            noiseSuppression: e.target.checked
        });

        await client.publish([localAudioTrack]);
        showNotification(e.target.checked ? "Gürültü azaltma açıldı" : "Gürültü azaltma kapatıldı");
    } catch (err) {
        console.error("Noise suppression değişmesi hatası:", err);
        showNotification("Ayar uygulanamadı", "error");
    }
});

document.getElementById("autoGain")?.addEventListener("change", async (e) => {
    if (!localAudioTrack || screenShare) return;

    try {
        await localAudioTrack.setEnabled(false);

        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: {
                sampleRate: 48000,
                stereo: true,
                channel: 2,
                bitrate: 128
            },
            AEC: true,
            ANS: document.getElementById("noiseSuppression").checked,
            AGC: e.target.checked,
            noiseSuppression: true
        });

        await client.publish([localAudioTrack]);
        showNotification(e.target.checked ? "Otomatik Kazanç açıldı" : "Otomatik Kazanç kapatıldı");
    } catch (err) {
        console.error("Auto gain değişmesi hatası:", err);
        showNotification("Ayar uygulanamadı", "error");
    }
});

window.playTestSound = function() {
    const testAudio = new Audio("https://www.soundjay.com/buttons/beep-01a.mp3");
    const speakerId = document.getElementById("speakerSelect").value;
    
    // Eğer tarayıcı destekliyorsa seçilen hoparlörden çal
    if (testAudio.setSinkId && speakerId) {
        testAudio.setSinkId(speakerId).then(() => testAudio.play());
    } else {
        testAudio.play();
    }
};

window.saveAudioSettings = function() {
    closeSettings();
    console.log("Ayarlar kaydedildi, Lordum.");
};

// ==========================================
// 4. CHAT VE MESAJ SESLERİ
// ==========================================
function initChat() {
    const q = query(collection(db, "rooms", CHANNEL_NAME, "messages"), orderBy("timestamp", "asc"));
    
    onSnapshot(q, (snapshot) => {
        const c = document.getElementById("chatContainer");
        if(!c) return;
        
        const oldHeight = c.scrollHeight;
        c.innerHTML = "";
        
        snapshot.forEach((doc) => {
            const msg = doc.data();
            const isMe = msg.senderId === currentUser.uid;
            
            // Timestamp formatting
            let timeStr = "...";
            if (msg.timestamp) {
                const date = msg.timestamp.toDate();
                const hours = String(date.getHours()).padStart(2, "0");
                const mins = String(date.getMinutes()).padStart(2, "0");
                timeStr = `${hours}:${mins}`;
            }
            
            c.innerHTML += `
                <div class="message ${isMe ? "sent" : ""}">
                    ${!isMe ? `<img src="${msg.photo || 'assets/img/default-avatar.png'}" class="msg-avatar" title="${msg.senderName}">` : ''}
                    <div class="msg-content">
                        ${!isMe ? `<div class="msg-name">${msg.senderName}</div>` : ''}
                        <div class="msg-text">${escapeHtml(msg.text)}</div>
                        <div class="msg-time">${timeStr}</div>
                    </div>
                </div>`;
        });
        
        // Auto scroll
        setTimeout(() => {
            if (c.scrollHeight - c.scrollTop < oldHeight + 100) {
                c.scrollTop = c.scrollHeight;
            }
        }, 0);
    });

    document.getElementById("sendBtn")?.addEventListener("click", sendMessage);
    document.getElementById("msgInput")?.addEventListener("keypress", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
}

function escapeHtml(unsafe) {
    const div = document.createElement('div');
    div.textContent = unsafe;
    return div.innerHTML;
}

async function sendMessage() {
    const input = document.getElementById("msgInput");
    const text = input.value.trim();
    if (!text) return;
    
    try {
        await addDoc(collection(db, "rooms", CHANNEL_NAME, "messages"), {
            text: text, 
            senderId: currentUser.uid, 
            senderName: currentUser.displayName, 
            photo: currentUser.photoURL, 
            timestamp: serverTimestamp(),
            readBy: []
        });
        
        // Message sound
        sounds.msg.play().catch(() => {});
        input.value = "";
    } catch (err) {
        console.error("Mesaj gönderilemedi:", err);
        showNotification("Mesaj gönderilemedi. Tekrar dene.", "error");
    }
}

// ==========================================
// 5. FIREBASE YÖNETİMİ
// ==========================================
async function addToRoomList(isMutedStart) {
    try {
        const roomRef = doc(db, "rooms", CHANNEL_NAME);
        console.log("📝 Firestore'a user ekleniyor:", CHANNEL_NAME);
        
        const docSnap = await getDoc(roomRef);
        if (!docSnap.exists()) {
            console.error("❌ Oda Firestore'da bulunamadı:", CHANNEL_NAME);
            throw new Error(`Room not found in Firestore: ${CHANNEL_NAME}`);
        }

        let users = (docSnap.data().users || []).filter(u => u.uid !== currentUser.uid);
        users.push({
            uid: currentUser.uid,
            name: currentUser.displayName || "Lord",
            photo: currentUser.photoURL || "assets/img/default-avatar.png",
            isMuted: isMutedStart
        });
        
        await updateDoc(roomRef, { users: users });
        console.log("✅ User Firestore'a eklendi");
        logEvent("connection", "User added to room in Firestore");
    } catch (err) {
        console.error("❌ Firestore addToRoomList hatası:", err);
        logEvent("error", "Failed to add user to Firestore", { error: err.message });
        throw err; // Propagate error
    }
}

async function updateUserStatusInDB(newMuteStatus) {
    const roomRef = doc(db, "rooms", CHANNEL_NAME);
    const docSnap = await getDoc(roomRef);
    if (docSnap.exists()) {
        let users = (docSnap.data().users || []).map(u => u.uid === currentUser.uid ? { ...u, isMuted: newMuteStatus } : u);
        await updateDoc(roomRef, { users: users });
    }
}

async function handleCleanup() {
    try {
        console.log("🧹 Cleanup başladı...");
        
        if (!CHANNEL_NAME || !currentUser) return;
        
        // 1. Screen sharing'i kapat
        if (screenShare) {
            await stopScreenShare().catch(e => console.warn("Screen share stop hatası:", e));
        }
        
        // 2. TÜTT TRACK'LERİ UNPUBLISH ET
        try {
            const publishedTracks = client.localAudioTrack ? [client.localAudioTrack] : [];
            if (publishedTracks.length > 0) {
                await client.unpublish(publishedTracks);
                console.log("✅ Tracks unpublished");
            }
        } catch (err) {
            console.warn("Unpublish hatası:", err);
        }
        
        // 3. AUDIO TRACK'İ KAPAT
        if (localAudioTrack) {
            try {
                localAudioTrack.stop();
                localAudioTrack.close();
                console.log("✅ Audio track closed");
            } catch (err) {
                console.warn("Audio track close hatası:", err);
            }
        }
        
        // 4. AGORA'DAN AYRIL
        try {
            await client.leave();
            console.log("✅ Agora channel left");
        } catch (err) {
            console.warn("Client leave hatası:", err);
        }
        
        // 5. FIRESTORE - KULLANICI LİSTESİNDEN ÇIKAR
        const roomRef = doc(db, "rooms", CHANNEL_NAME);
        try {
            const docSnap = await getDoc(roomRef);
            if (docSnap.exists()) {
                const users = (docSnap.data().users || []).filter(u => u.uid !== currentUser.uid);
                await updateDoc(roomRef, { users: users });
                console.log("✅ User removed from Firestore");
            }
        } catch (err) {
            console.warn("Firestore update hatası:", err);
        }
        
        console.log("🧹 Cleanup tamamlandı!");
        logEvent("connection", "Cleanup completed successfully");
    } catch (err) {
        console.error("Cleanup hatası:", err);
        logEvent("error", "Cleanup failed", { error: err.message });
    }
}

// ==========================================
// 6. UI YÖNETİMİ
// ==========================================
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

// ==========================================
// 7. KONTROLLER
// ==========================================
window.toggleMic = async function() {
    if (!localAudioTrack) return;
    isMicMuted = !isMicMuted;
    await localAudioTrack.setMuted(isMicMuted);
    
    const btn = document.getElementById("micBtn");
    btn.classList.toggle("hangup", isMicMuted);
    btn.querySelector("i").className = isMicMuted ? "fa-solid fa-microphone-slash" : "fa-solid fa-microphone";
    
    updateUserStatusInDB(isMicMuted);
}

window.toggleAudio = function() {
    const btn = document.getElementById("audioBtn");
    const icon = btn.querySelector("i");
    isAudioMuted = !isAudioMuted;

    client.remoteUsers.forEach(user => {
        if (user.audioTrack) isAudioMuted ? user.audioTrack.stop() : user.audioTrack.play();
    });

    btn.classList.toggle("hangup", isAudioMuted);
    icon.className = isAudioMuted ? "fa-solid fa-volume-xmark" : "fa-solid fa-headphones";
}

window.leaveRoom = async function() {
    try {
        showNotification("Bölgeden ayrılınız...");
        logEvent("connection", "User leaving room");
        
        // Screen sharing'i kapat
        if (screenShare) {
            try {
                await stopScreenShare();
            } catch (err) {
                console.warn("Screen share stop failed on leave:", err);
            }
        }
        
        // Cleanup'ı çalıştır
        await handleCleanup();
        
        // Dashboard'a dön
        setTimeout(() => {
            window.location.href = "dashboard.html";
        }, 500);
    } catch (err) {
        console.error("Leave room hatası:", err);
        showNotification("Çıkış sırasında hata, sayfayı yenileyip dene", "error");
        logEvent("error", "Leave room failed", { error: err.message });
        setTimeout(() => window.location.href = "dashboard.html", 2000);
    }
}

/* ================= STREAMING STATE & BUTTON MANAGEMENT ================= */

let streamingState = {
    screenShare: { active: false, error: null },
    cameraShare: { active: false, error: null },
    audio: { active: true, error: null }
};

function updateButtonStates() {
    // Screen Share Button
    const screenBtn = document.querySelector('button[title="Ekran Paylaş"]');
    if (screenBtn) {
        screenBtn.classList.toggle("active-stream", screenShare);
        screenBtn.style.opacity = !roomFeatures.screenShare ? "0.5" : "1";
        screenBtn.disabled = !roomFeatures.screenShare;
        
        if (streamingState.screenShare.error) {
            screenBtn.setAttribute("data-error", streamingState.screenShare.error);
            screenBtn.classList.add("error-state");
        } else {
            screenBtn.removeAttribute("data-error");
            screenBtn.classList.remove("error-state");
        }
    }
    
    // Camera Button
    const cameraBtn = document.querySelector('button[title="Kamera Paylaş"]');
    if (cameraBtn) {
        cameraBtn.classList.toggle("active-stream", cameraShare);
        cameraBtn.style.opacity = !roomFeatures.video ? "0.5" : "1";
        cameraBtn.disabled = !roomFeatures.video;
        
        if (streamingState.cameraShare.error) {
            cameraBtn.setAttribute("data-error", streamingState.cameraShare.error);
            cameraBtn.classList.add("error-state");
        } else {
            cameraBtn.removeAttribute("data-error");
            cameraBtn.classList.remove("error-state");
        }
    }
    
    // Mic Button
    const micBtn = document.getElementById("micBtn");
    if (micBtn) {
        micBtn.classList.toggle("hangup", isMicMuted);
    }
}

function setStreamingError(type, error) {
    if (type === "screen" || type === "camera") {
        streamingState[`${type}Share`].error = error;
        updateButtonStates();
        
        // Clear error after 5 seconds
        setTimeout(() => {
            streamingState[`${type}Share`].error = null;
            updateButtonStates();
        }, 5000);
    }
}

function clearStreamingError(type) {
    if (streamingState[`${type}Share`]) {
        streamingState[`${type}Share`].error = null;
        updateButtonStates();
    }
}

/* ================= SCREEN SHARING ================= */
window.startScreenShare = async function() {
    try {
        if (!roomFeatures.screenShare) {
            showNotification("Ekran paylaşımı bu bölgede kapalı", "error");
            logEvent("error", "Screen share disabled in room", { features: roomFeatures });
            return;
        }
        
        if (screenShare) {
            await stopScreenShare();
            return;
        }
        
        // Kamera açıksa hata ver
        if (cameraShare) {
            showNotification("⚠️ Kamera açıkken ekran paylaşamazsın", "error");
            return;
        }
        
        // Kamera track'i hala yayınlanıyorsa, onu da durdur
        if (cameraVideoTrack) {
            try {
                await client.unpublish([cameraVideoTrack]);
                cameraVideoTrack.stop();
                cameraVideoTrack.close?.();
            } catch (err) {
                console.warn("Camera cleanup before screen:", err);
            }
            cameraVideoTrack = null;
        }
        
        showNotification("Ekran paylaşımı başlatılıyor...");
        
        try {
            // SCREEN AUDIO (tam kurulacak)
            try {
                screenAudioTrack = await AgoraRTC.createScreenAudioTrack();
            } catch (err) {
                console.warn("Screen audio unavailable:", err);
                screenAudioTrack = null;
            }
            
            // SCREEN VIDEO (optimized encoder)
            screenVideoTrack = await AgoraRTC.createScreenVideoTrack({
                encoderConfig: {
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: 30,
                    bitrateMin: 5000,
                    bitrateMax: 8000
                }
            });
        } catch (err) {
            console.error("Ekran capture hatası:", err);
            const errorMsg = err.message?.includes("Permission") ? "İzin reddedildi" : "Başlatılamadı";
            setStreamingError("screen", errorMsg);
            if (err.message?.includes("Permission denied")) {
                showNotification("❌ Ekran paylaşım izni verilmedi", "error");
            } else {
                showNotification("Ekran paylaşımı başlatılamadı: " + err.message, "error");
            }
            return;
        }
        
        // Audio track'i UNPUBLISH et
        if (localAudioTrack) {
            try {
                await client.unpublish([localAudioTrack]);
                console.log("✅ Audio unpublished (preparing for screen)");
            } catch (err) {
                console.warn("Audio unpublish error:", err);
            }
        }
        
        // Screen track'leri publish et
        const tracksToPub = [screenVideoTrack];
        if (screenAudioTrack) tracksToPub.push(screenAudioTrack);
        
        try {
            await client.publish(tracksToPub);
            console.log("✅ Screen tracks published");
        } catch (err) {
            console.error("Screen publish error:", err);
            showNotification("Ekran yayınlanamadı", "error");
            screenVideoTrack?.close?.();
            screenAudioTrack?.close?.();
            return;
        }
        
        screenShare = true;
        clearStreamingError("screen");
        updateButtonStates();
        const btn = document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.add("hangup");
            btn.innerHTML = '<i class="fa-solid fa-share-alt"></i>';
            btn.disabled = false;
        }
        
        // Video'yu göster
        if (screenVideoTrack) {
            try {
                await attachVideoTrack(screenVideoTrack, `screen-${currentUser.uid}`, currentUser.displayName + " 🖥️", "screen");
                console.log("✅ Screen video displayed");
            } catch (err) {
                console.error("❌ Failed to display screen video:", err);
                showNotification("Ekran görüntülenemedi", "error");
            }
        }
        
        showNotification("Ekranın paylaşılıyor ✨");
        logEvent("video", "Screen share started");
        
        // Screen share bittiyse (user browser'dan stop etse)
        if (screenVideoTrack) {
            screenVideoTrack.on("ended", async () => {
                console.log("📺 Ekran capture ended (user stopped)");
                await stopScreenShare();
            });
        }
        
    } catch (err) {
        console.error("Screen share error:", err);
        showNotification("Ekran paylaşımı hatası", "error");
        screenShare = false;
    }
}

window.stopScreenShare = async function() {
    try {
        console.log("🔴 Screen share stopping...");
        
        // Publish'ı hemen bırak
        const tracksToStop = [];
        if (screenVideoTrack) tracksToStop.push(screenVideoTrack);
        if (screenAudioTrack) tracksToStop.push(screenAudioTrack);
        
        if (tracksToStop.length > 0) {
            try {
                await client.unpublish(tracksToStop);
                console.log("✅ Screen tracks unpublished");
            } catch (err) {
                console.warn("Unpublish error:", err);
            }
        }
        
        // Track'leri kapat
        if (screenAudioTrack) {
            try {
                screenAudioTrack.stop();
                screenAudioTrack.close?.();
            } catch (err) {
                console.warn("Audio track close:", err);
            }
            screenAudioTrack = null;
        }
        
        if (screenVideoTrack) {
            try {
                screenVideoTrack.stop();
                screenVideoTrack.close?.();
            } catch (err) {
                console.warn("Video track close:", err);
            }
            screenVideoTrack = null;
        }
        
        // Mikrofon track'ini GERİ OLUŞTUR ve publish et
        if (!cameraShare) {
            try {
                console.log("🔄 Microphone re-publishing...");
                localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
                    encoderConfig: {
                        sampleRate: 48000,
                        stereo: true,
                        channel: 2,
                        bitrate: 128
                    },
                    AEC: true, ANS: true, AGC: true,
                    noiseSuppression: true
                });
                
                await client.publish([localAudioTrack]);
                console.log("✅ Microphone republished");
                
                // Advanced audio pipeline restore
                await setupAdvancedAudio().catch((err) => {
                    console.warn("Advanced audio setup failed:", err);
                });
            } catch (err) {
                console.error("Microphone restore error:", err);
                showNotification("Ses geri açılamadı, tekrar deneyin", "error");
            }
        }
        
        screenShare = false;
        updateButtonStates();
        
        // Button'ı update et
        const btn = document.querySelector('button[title="Ekran Paylaş"]');
        if (btn) {
            btn.classList.remove("hangup");
            btn.innerHTML = '<i class="fa-solid fa-desktop"></i>';
            btn.disabled = false;
        }
        
        // Video'yu kaldır
        removeVideoTrack(`screen-${currentUser.uid}`);
        
        showNotification("Ekran paylaşmayı durdurdu");
        logEvent("video", "Screen share stopped");
    } catch (err) {
        console.error("Stop screen share error:", err);
        showNotification("Ekran durdurma hatası", "error");
    }
}

// ==========================================
// KAMERA PAYLAŞMA FONKSIYONLARI
// ==========================================
window.startCameraShare = async function() {
    try {
        if (!roomFeatures.video) {
            showNotification("Kamera bu bölgede kapalı", "error");
            logEvent("error", "Camera disabled in room", { features: roomFeatures });
            return;
        }
        
        // Ekran açıksa hata ver
        if (screenShare) {
            showNotification("⚠️ Ekran paylaşımı açıkken kamera açamazsın", "error");
            return;
        }
        
        // Screen track'i hala yayınlanıyorsa, onu da durdur
        if (screenVideoTrack) {
            try {
                await client.unpublish([screenVideoTrack]);
                screenVideoTrack.stop();
                screenVideoTrack.close?.();
            } catch (err) {
                console.warn("Screen cleanup before camera:", err);
            }
            screenVideoTrack = null;
        }
        if (screenAudioTrack) {
            try {
                screenAudioTrack.stop();
                screenAudioTrack.close?.();
            } catch (err) {
                console.warn("Screen audio cleanup:", err);
            }
            screenAudioTrack = null;
        }
        
        if (cameraShare) {
            await stopCameraShare();
            return;
        }
        
        showNotification("Kamera başlatılıyor...");
        
        try {
            cameraVideoTrack = await AgoraRTC.createCameraVideoTrack({
                encoderConfig: {
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    frameRate: 24,
                    bitrateMin: 800,
                    bitrateMax: 2500
                }
            });
        } catch (err) {
            console.error("Camera creation error:", err);
            const errorMsg = err.message?.includes("Permission") ? "İzin reddedildi" : "Başlatılamadı";
            setStreamingError("camera", errorMsg);
            if (err.message?.includes("Permission")) {
                showNotification("❌ Kamera izni reddedildi", "error");
            } else {
                showNotification("Kamera başlatılamadı: " + err.message, "error");
            }
            cameraVideoTrack = null;
            return;
        }
        
        // Audio track'i unpublish et (sadece ses göndereceğiz)
        if (localAudioTrack) {
            try {
                await client.unpublish([localAudioTrack]);
                console.log("✅ Audio unpublished (camera only)");
            } catch (err) {
                console.warn("Audio unpublish error:", err);
            }
        }
        
        // Camera track'i publish et
        const tracksToPub = [cameraVideoTrack];
        if (localAudioTrack && !screenShare) {
            tracksToPub.push(localAudioTrack);
        }
        
        try {
            await client.publish(tracksToPub);
            console.log("✅ Camera tracks published");
        } catch (err) {
            console.error("Camera publish error:", err);
            showNotification("Kamera yayınlanamadı", "error");
            cameraVideoTrack?.close?.();
            return;
        }
        
        cameraShare = true;
        clearStreamingError("camera");
        updateButtonStates();
        const btn = document.querySelector('button[title="Kamera Paylaş"]');
        if (btn) {
            btn.classList.add("hangup");
            btn.innerHTML = '<i class="fa-solid fa-camera-slash"></i>';
            btn.disabled = false;
        }
        
        // Video'yu göster
        try {
            await attachVideoTrack(cameraVideoTrack, currentUser.uid, (currentUser.displayName || "Sen") + " 📹", "camera");
            console.log("✅ Camera video displayed");
        } catch (err) {
            console.error("❌ Failed to display camera video:", err);
            showNotification("Kamera görüntülenemedi", "error");
        }
        
        showNotification("Kamera paylaşılıyor 📹");
        logEvent("video", "Camera share started");
        
        // Kamera kapatıldıysa
        if (cameraVideoTrack) {
            cameraVideoTrack.on("ended", async () => {
                console.log("📹 Camera ended (user stopped)");
                await stopCameraShare();
            });
        }
        
    } catch (err) {
        console.error("Camera share error:", err);
        showNotification("Kamera hatası", "error");
        cameraShare = false;
    }
}

window.stopCameraShare = async function() {
    try {
        console.log("🔴 Camera share stopping...");
        
        // Publish'ı unpublish et
        if (cameraVideoTrack) {
            try {
                await client.unpublish([cameraVideoTrack]);
                cameraVideoTrack.stop();
                cameraVideoTrack.close?.();
            } catch (err) {
                console.warn("Camera track stop error:", err);
            }
            cameraVideoTrack = null;
        }
        
        // Mikrofon track'ini GERİ publish et (ekran açık değilse)
        if (!screenShare) {
            try {
                console.log("🔄 Microphone re-publishing after camera stop...");
                localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
                    encoderConfig: {
                        sampleRate: 48000,
                        stereo: true,
                        channel: 2,
                        bitrate: 128
                    },
                    AEC: true, ANS: true, AGC: true,
                    noiseSuppression: true
                });
                
                await client.publish([localAudioTrack]);
                console.log("✅ Microphone republished");
                
                // Advanced audio pipeline restore
                await setupAdvancedAudio().catch((err) => {
                    console.warn("Advanced audio setup failed:", err);
                });
            } catch (err) {
                console.error("Microphone restore error:", err);
                showNotification("Ses geri açılamadı", "error");
            }
        }
        
        cameraShare = false;
        updateButtonStates();
        
        // Button'ı update et
        const btn = document.querySelector('button[title="Kamera Paylaş"]');
        if (btn) {
            btn.classList.remove("hangup");
            btn.innerHTML = '<i class="fa-solid fa-camera"></i>';
            btn.disabled = false;
        }
        
        // Video'yu kaldır
        removeVideoTrack(currentUser.uid);
        
        showNotification("Kamera kapatıldı");
        logEvent("video", "Camera share stopped");
    } catch (err) {
        console.error("Stop camera error:", err);
        showNotification("Kamera durdurma hatası", "error");
    }
}

// ==========================================
// VİDEO DISPLAY & GRID MANAGEMENT
// ==========================================

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

function attachVideoTrack(track, uid, name, type = "camera") {
    return new Promise((resolve, reject) => {
        try {
            if (!track) {
                console.warn("❌ Video track boş:", uid);
                reject(new Error("Video track not found"));
                return;
            }
            
            const videoStage = document.getElementById("videoStage");
            if (!videoStage) {
                console.error("❌ videoStage element bulunamadı!");
                reject(new Error("Video stage not found"));
                return;
            }
            
            showVideoStage();
            
            // Remove if exists
            const existing = document.getElementById(`video-${uid}`);
            if (existing) {
                console.log(`🔄 Video updating: ${uid}`);
                existing.remove();
            }
            
            // Create video container
            const container = document.createElement("div");
            container.className = `video-container ${type === "screen" ? "screen-share" : "camera-share"}`;
            container.id = `video-${uid}`;
            
            // Create video element
            const videoEl = document.createElement("video");
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.muted = (uid === currentUser.uid); // Local video muted
            videoEl.style.width = "100%";
            videoEl.style.height = "100%";
            videoEl.style.objectFit = "contain";
            
            // Play video track
            track.play(videoEl).then(() => {
                console.log(`✅ Video playing: ${uid}`);
                resolve();
            }).catch(err => {
                console.warn("⚠️ Video play error:", err);
                showNotification("Video görüntülenemedi", "error");
                reject(err);
            });
            
            // Add label
            const label = document.createElement("div");
            label.className = "video-label";
            label.style.position = "absolute";
            label.style.bottom = "10px";
            label.style.left = "10px";
            label.style.background = "rgba(0,0,0,0.6)";
            label.style.padding = "8px 12px";
            label.style.borderRadius = "8px";
            label.style.fontSize = "0.85rem";
            label.style.color = "#fff";
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";
            label.innerHTML = `
                <i class="fa-solid ${type === "screen" ? "fa-desktop" : "fa-camera"}"></i>
                <span>${name}</span>
            `;
            
            container.appendChild(videoEl);
            container.appendChild(label);
            container.style.position = "relative";
            container.style.overflow = "hidden";
            container.style.borderRadius = "12px";
            container.style.background = "#000";
            container.style.aspectRatio = "16/9";
            
            videoStage.appendChild(container);
            
            // Store reference
            videoTracks.set(uid, { element: container, track, type });
            currentVideoMode = type;
            
            console.log(`✅ Video attached: ${uid} (${type})`);
            logEvent("video", "Video track attached", { uid, type });
        } catch (err) {
            console.error("❌ Attach video error:", err);
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

// Desktop viewport detection & panel toggle
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

window.openSettings = () => document.getElementById("settingsModal").classList.add("active");
window.closeSettings = () => document.getElementById("settingsModal").classList.remove("active");

async function getDevices() {
    const devices = await AgoraRTC.getDevices();
    const micSelect = document.getElementById("micSelect");
    const spkSelect = document.getElementById("speakerSelect");
    if(!micSelect || !spkSelect) return;
    micSelect.innerHTML = ""; spkSelect.innerHTML = "";
    devices.forEach(device => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.text = device.label || `Cihaz ${device.deviceId.slice(0,5)}`;
        if (device.kind === "audioinput") micSelect.appendChild(option);
        if (device.kind === "audiooutput") spkSelect.appendChild(option);
    });
}

// Cihaz değiştirme - Fallback ile robust
window.changeAudioQuality = async function() {
    const quality = document.getElementById("audioQuality").value;
    const bitrates = { high: 128, medium: 96, low: 64 };
    
    if (!localAudioTrack || screenShare) return;
    
    try {
        await localAudioTrack.setEnabled(false);
        
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: {
                sampleRate: 48000,
                stereo: true,
                channel: 2,
                bitrate: bitrates[quality]
            },
            AEC: true, ANS: true, AGC: true
        });
        
        await client.publish([localAudioTrack]);
        showNotification(`Ses kalitesi: ${quality.toUpperCase()}`);
        logEvent("audio", "Audio quality changed", { quality, bitrate: bitrates[quality] });
    } catch (err) {
        console.error("Audio quality change error:", err);
        showNotification("Kalite değiştirilemedi", "error");
    }
}

window.changeDevice = async function(type) {
    const deviceId = type === 'mic' ? document.getElementById("micSelect").value : document.getElementById("speakerSelect").value;
    try {
        if (type === 'mic' && localAudioTrack && !screenShare) {
            await localAudioTrack.setDevice(deviceId);
            showNotification("Mikrofon değiştirildi ✓");
        } else if (type === 'speaker') {
            let changeCount = 0;
            let failCount = 0;
            
            client.remoteUsers.forEach(user => {
                if (user.audioTrack) {
                    user.audioTrack.setPlaybackDevice(deviceId).then(() => {
                        changeCount++;
                    }).catch((err) => {
                        failCount++;
                        console.warn("Hoparlör değiştirilemedi bir kullanıcı için:", err);
                    });
                }
            });
            
            if (changeCount > 0 || failCount > 0) {
                showNotification(`Hoparlör güncellendi (${changeCount} kullanıcı)`);
            }
        }
    } catch (err) { 
        console.error("Cihaz değişmedi:", err);
        showNotification("Cihaz değiştirilemedi", "error");
    }
};

window.togglePanel = function(panelName) {
    const rightPanel = document.getElementById("rightPanel");
    const leftPanel = document.querySelector(".left-panel");
    const usersToggleBtn = document.getElementById("desktopUsersToggle");
    const chatToggleBtn = document.getElementById("desktopChatToggle");
    
    if (panelName === 'chat') {
        rightPanel.classList.toggle("active");
        leftPanel.classList.remove("active");
        
        // Update button states
        if (chatToggleBtn) chatToggleBtn.classList.toggle("active", rightPanel.classList.contains("active"));
        if (usersToggleBtn) usersToggleBtn.classList.remove("active");
    } else if (panelName === 'users') {
        leftPanel.classList.toggle("active");
        rightPanel.classList.remove("active");
        
        // Update button states
        if (usersToggleBtn) usersToggleBtn.classList.toggle("active", leftPanel.classList.contains("active"));
        if (chatToggleBtn) chatToggleBtn.classList.remove("active");
    }
}

// Close panel when clicking backdrop (non-panel area)
window.closePanels = function() {
    const rightPanel = document.getElementById("rightPanel");
    const leftPanel = document.querySelector(".left-panel");
    const usersToggleBtn = document.getElementById("desktopUsersToggle");
    const chatToggleBtn = document.getElementById("desktopChatToggle");
    
    rightPanel?.classList.remove("active");
    leftPanel?.classList.remove("active");
    
    if (usersToggleBtn) usersToggleBtn.classList.remove("active");
    if (chatToggleBtn) chatToggleBtn.classList.remove("active");
}

// Specific panel close
window.closePanel = function(which) {
    const rightPanel = document.getElementById("rightPanel");
    const leftPanel = document.querySelector(".left-panel");
    const usersToggleBtn = document.getElementById("desktopUsersToggle");
    const chatToggleBtn = document.getElementById("desktopChatToggle");
    
    if (which === "chat") {
        rightPanel?.classList.remove("active");
        if (chatToggleBtn) chatToggleBtn.classList.remove("active");
    } else if (which === "users") {
        leftPanel?.classList.remove("active");
        if (usersToggleBtn) usersToggleBtn.classList.remove("active");
    } else {
        rightPanel?.classList.remove("active");
        leftPanel?.classList.remove("active");
        if (usersToggleBtn) usersToggleBtn.classList.remove("active");
        if (chatToggleBtn) chatToggleBtn.classList.remove("active");
    }
}

// Setup panel backdrop click handlers
document.addEventListener("DOMContentLoaded", function() {
    const leftPanel = document.querySelector(".left-panel");
    const rightPanel = document.getElementById("rightPanel");
    
    // Create backdrop click handlers using pseudo-element click simulation
    if (leftPanel && rightPanel) {
        // Close on ESC key
        document.addEventListener("keydown", function(e) {
            if (e.key === "Escape") {
                closePanels();
            }
        });
        
        // Close on backdrop click (when clicking outside panels on mobile)
        document.addEventListener("click", function(e) {
            const clickedOnLeftPanel = leftPanel.contains(e.target);
            const clickedOnRightPanel = rightPanel.contains(e.target);
            const clickedOnToggle = e.target.closest(".mobile-toggle") || e.target.closest(".mobile-close");
            
            // If clicked outside panels and not on toggle buttons
            if (!clickedOnLeftPanel && !clickedOnRightPanel && !clickedOnToggle) {
                // Check if panels are open and close them
                if (leftPanel.classList.contains("active") || rightPanel.classList.contains("active")) {
                    closePanels();
                }
            }
        });
    }
});

/* ================= ERROR LOGGING & DIAGNOSTICS ================= */
const diagnostics = {
    startTime: Date.now(),
    audioEvents: [],
    connectionEvents: [],
    errors: []
};

function logEvent(type, message, data = {}) {
    const event = { time: Date.now(), type, message, data };
    if (type === "error") diagnostics.errors.push(event);
    else if (type === "audio") diagnostics.audioEvents.push(event);
    else if (type === "connection") diagnostics.connectionEvents.push(event);
    
    console.log(`[${type.toUpperCase()}] ${message}`, data);
}

window.showDiagnostics = function() {
    console.clear();
    console.log("╔═══════════════════════════════════════════════════════════════╗");
    console.log("║        🐉 LEGACY VOICE CHAT - DIAGNOSTICS REPORT 🐉          ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝");
    
    console.log("\n📊 SESSION INFO:");
    console.log("├─ Duration:", Math.round((Date.now() - diagnostics.startTime) / 1000), "seconds");
    console.log("├─ Channel:", CHANNEL_NAME);
    console.log("├─ Current User:", currentUser?.uid);
    console.log("└─ Room Name:", currentRoomName);
    
    console.log("\n🎤 AUDIO STATE:");
    console.log("├─ Local Audio Track:", localAudioTrack ? "✅ Active" : "❌ None");
    console.log("├─ Mic Muted:", isMicMuted ? "🔇 YES" : "🔊 NO");
    console.log("├─ Audio Muted:", isAudioMuted ? "❌ YES" : "✅ NO");
    console.log("├─ Screen Share:", screenShare ? "📺 YES" : "❌ NO");
    console.log("└─ Audio Context:", audioContext?.state || "❌ None");
    
    console.log("\n🌐 AGORA STATE:");
    console.log("├─ Connection State:", client?.connectionState || "❌ Unknown");
    console.log("├─ Remote Users:", client?.remoteUsers?.length || 0, "👥");
    if (client?.remoteUsers?.length > 0) {
        client.remoteUsers.forEach((u, i) => {
            console.log(`   │  ${i+1}. UID: ${u.uid}, Audio: ${u.audioTrack ? '✅' : '❌'}`);
        });
    }
    console.log("└─ App ID:", AGORA_APP_ID.slice(0, 8) + "...");
    
    console.log("\n📈 STATS:");
    console.log("├─ Audio Events:", diagnostics.audioEvents.length);
    console.log("├─ Connection Events:", diagnostics.connectionEvents.length);
    console.log("└─ Errors:", diagnostics.errors.length);
    
    if (diagnostics.errors.length > 0) {
        console.log("\n❌ ERROR LOG:");
        diagnostics.errors.slice(-5).forEach((e, i) => {
            console.log(`├─ [${new Date(e.time).toLocaleTimeString()}] ${e.message}`);
            if (e.data) console.log(`│  Data:`, e.data);
        });
    }
    
    console.log("\n🛠️  TROUBLESHOOTING COMMANDS:");
    console.log("├─ testConnection() - Test Agora connection");
    console.log("├─ checkRemoteUsers() - Detailed remote users info");
    console.log("├─ fixAudioTrack() - Try to fix audio issues");
    console.log("├─ resetAgoraClient() - Reconnect to Agora");
    console.log("├─ testMic() - Play test sound");
    console.log("├─ testAudio() - Play audio test");
    console.log("└─ leaveRoom() - Leave and return to lobby");
    
    console.log("\n💡 TIPS:");
    console.log("├─ If users can't hear you, run: testConnection()");
    console.log("├─ If console shows errors, report the ERROR LOG above");
    console.log("└─ If stuck, refresh page or run: resetAgoraClient()");
}

// TROUBLESHOOTING FUNCTIONS
window.testConnection = async function() {
    console.log("🔍 Testing Agora connection...");
    console.log("• Agora SDK:", typeof AgoraRTC !== 'undefined' ? "✅ Loaded" : "❌ Missing");
    console.log("• Client:", client ? "✅ Created" : "❌ Missing");
    console.log("• Connection State:", client?.connectionState || "❌ Unknown");
    console.log("• Remote Users:", client?.remoteUsers?.length || 0);
    console.log("• Local Audio Track:", localAudioTrack ? "✅ Active" : "❌ None");
    
    if (client?.connectionState === "CONNECTED") {
        console.log("✅ Agora bağlantısı iyi!");
    } else {
        console.log("⚠️  Agora bağlantısı sorunlu - sayfayı yenile");
    }
}

window.checkRemoteUsers = function() {
    console.log("👥 DETAILED REMOTE USERS INFO:");
    console.log("Count:", client?.remoteUsers?.length || 0);
    
    client?.remoteUsers?.forEach((user, idx) => {
        console.group(`User ${idx + 1}: ${user.uid}`);
        console.log("├─ Has Audio Track:", user.audioTrack ? "✅" : "❌");
        console.log("├─ Has Video Track:", user.videoTrack ? "✅" : "❌");
        console.log("├─ Published:", user.hasAudio ? "✅ Audio" : "❌");
        console.log("└─ User Object Keys:", Object.keys(user).join(", "));
        console.groupEnd();
    });
}

window.fixAudioTrack = async function() {
    console.log("🔧 Attempting to fix audio track...");
    try {
        if (screenShare) {
            console.log("⚠️  Screen share aktif, durduruluyor...");
            await stopScreenShare();
        }
        
        console.log("🔄 Recreating audio track...");
        if (localAudioTrack) {
            localAudioTrack.stop();
            localAudioTrack.close?.();
        }
        
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: { sampleRate: 48000, stereo: true, bitrate: 128 },
            AEC: true, ANS: true, AGC: true
        });
        
        await client.unpublish([localAudioTrack]).catch(() => {});
        await client.publish([localAudioTrack]);
        await setupAdvancedAudio().catch((err) => {
            console.warn("Advanced audio setup failed in fixAudioTrack:", err);
        });
        
        console.log("✅ Audio track fixed!");
        showNotification("Ses track sabitlendi!");
    } catch (err) {
        console.error("Fix failed:", err);
        showNotification("Ses track düzeltilemiyor" , "error");
    }
}

window.resetAgoraClient = async function() {
    console.log("🔄 Resetting Agora client...");
    showNotification("Bağlantı yeniden kuruluyor...");
    try {
        await handleCleanup();
        setTimeout(() => location.reload(), 1000);
    } catch (err) {
        console.error("Reset failed:", err);
        location.reload();
    }
}

// Test functions
window.testMic = async function() {
    showNotification("Mikrofon test başlıyor...");
    const testAudio = new Audio("https://www.soundjay.com/buttons/beep-01a.mp3");
    testAudio.play();
}

window.testAudio = async function() {
    showNotification("Hoparlör test başlıyor...");
    const testAudio = new Audio("https://www.soundjay.com/buttons/beep-08b.mp3");
    testAudio.play();
}

// Error capture
window.addEventListener("error", (e) => {
    logEvent("error", e.message, { filename: e.filename, lineno: e.lineno });
});

window.addEventListener("unhandledrejection", (e) => {
    logEvent("error", "Unhandled Promise Rejection", { reason: e.reason });
});

function showNotification(message, type = 'success') {
    const notif = document.createElement("div");
    notif.className = "room-notification notification-" + type;
    notif.innerHTML = `
        <i class="fa-solid ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.classList.add("show");
    }, 10);
    
    setTimeout(() => {
        notif.classList.remove("show");
        setTimeout(() => notif.remove(), 300);
    }, 3000);
}
