const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const ping = require('ping');
const serviceAccount = require('./serviceAccountKey.json');

// Initialisation de Firebase
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// Scan toutes les 60 secondes (1 minute)
const CHECK_INTERVAL = 60000; 

async function checkAllRooms() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Lancement du scan des bornes Ethernet...`);
    
    try {
        const snapshot = await db.collection('chambres').get();

        for (const doc of snapshot.docs) {
            const room = doc.data();
            let hasChanges = false;

            // 1. Scan des bornes AP
            let updatedAps = [];
            if (room.aps && room.aps.length > 0) {
                updatedAps = await Promise.all(room.aps.map(async (ap) => {
                    if (!ap.ip) return ap;
                    
                    const res = await ping.promise.probe(ap.ip, { timeout: 2 });
                    const newStatus = res.alive ? '🟢 ONLINE' : '🔴 OFFLINE';
                    
                    if (ap.status !== newStatus) hasChanges = true;
                    return { ...ap, status: newStatus };
                }));
            }

            // 2. Scan du Téléphone IP
            let newPhoneStatus = room.phoneStatus || '⚪ Non vérifié';
            if (room.phoneIp) {
                const res = await ping.promise.probe(room.phoneIp, { timeout: 2 });
                newPhoneStatus = res.alive ? '🟢 ONLINE' : '🔴 OFFLINE';
                if (room.phoneStatus !== newPhoneStatus) hasChanges = true;
            }

            // 3. Mise à jour Firebase si changement
            if (hasChanges) {
                await db.collection('chambres').doc(doc.id).update({
                    aps: updatedAps,
                    phoneStatus: newPhoneStatus,
                    lastCheckedAt: FieldValue.serverTimestamp()
                });
                console.log(`  ✅ Chambre "${room.name}" mise à jour.`);
            }
        }
        console.log(`[${new Date().toLocaleTimeString()}] ✨ Scan terminé.\n`);
    } catch (error) {
        console.error("❌ Erreur pendant le scan :", error);
    }
}

// Démarrage du script
checkAllRooms();
setInterval(checkAllRooms, CHECK_INTERVAL);