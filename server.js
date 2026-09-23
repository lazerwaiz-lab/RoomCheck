process.env.TZ = 'Africa/Porto-Novo';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // ✉️ Ajouté pour l'envoi d'e-mails

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccountKey.json');

// Initialisation de Firebase Admin
if (getApps().length === 0) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();
const app = express();

// ✉️ Configuration du transporteur SMTP pour noreply@centillion.online
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER || 'baa4d9001@smtp-brevo.com',
        pass: process.env.BREVO_SMTP_PASS
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000
});

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net", 
        "https://cdnjs.cloudflare.com", 
        "https://www.gstatic.com" // <--- Ajoutez ceci ici
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
  "'self'", 
  "https://roomcheck-1.onrender.com", 
  "https://roomcheck.centillion.online", 
  "http://localhost:3000", 
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://firestore.googleapis.com",       // <--- Ajoutez ceci
  "https://*.firestore.googleapis.com",     // <--- Et ceci
  "https://*.googleapis.com"                // <--- Et ceci pour être sûr
]
    },
  })
);

const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // ⏱️ 5 minutes
    max: 10, // Limite à 10 essais maximum par IP
    message: {
        success: false,
        message: "Trop de tentatives de connexion échouées. Veuillez réessayer dans 5 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ==========================================
// 🌟 2. SYSTÈMES DE MIROIR LOCAL (RC-LOCALDATA)
// ==========================================
const LOCAL_DATA_ROOT = path.join('C:', 'Users', 'TEST.DESKTOP-VS19RSE.000', 'OneDrive', 'Documents', 'IT RoomCheck', 'room-checker-service', 'RC-LOCALDATA');

function saveToLocalMirror(hotelId, collectionName, docId, data) {
    if (!hotelId || !collectionName) return;
    const dirPath = path.join(LOCAL_DATA_ROOT, 'hotels', hotelId, collectionName);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    const fileName = docId ? `${docId}.json` : `_collection.json`;
    const filePath = path.join(dirPath, fileName);
    
    let fileData = {};
    if (fs.existsSync(filePath)) {
        try { fileData = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { fileData = {}; }
    }
    if (docId) {
        fileData = { ...fileData, ...data, id: docId, localUpdatedAt: new Date().toISOString() };
    } else {
        fileData = data;
    }
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf8');
}

function readFromLocalMirror(hotelId, collectionName, docId) {
    try {
        const filePath = path.join(LOCAL_DATA_ROOT, 'hotels', hotelId, collectionName, docId ? `${docId}.json` : `_collection.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error("Erreur lecture RC-LOCALDATA:", e);
    }
    return null;
}
// ==========================================

// 1. Configuration CORS
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'https://roomcheck.centillion.online',
    'https://roomcheck-1.onrender.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Accès bloqué par la politique CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 1. ROUTE D'INSCRIPTION D'UN NOUVEL HÔTEL
// ==========================================
app.post('/api/register-hotel', async (req, res) => {
    const { hotelName, adminName, adminEmail, password } = req.body;

    if (!hotelName || !adminName || !adminEmail || !password) {
        return res.status(400).json({ success: false, message: 'Tous les champs sont obligatoires.' });
    }

    try {
        const cleanName = hotelName.trim();
        const cleanEmail = adminEmail.trim().toLowerCase();

        const allHotelsSnapshot = await db.collection('hotels').get();
        let existingHotelName = null;

        for (const doc of allHotelsSnapshot.docs) {
            const data = doc.data();
            if (data.name && data.name.trim().toLowerCase() === cleanName.toLowerCase()) {
                existingHotelName = data.name;
                break;
            }
        }

        if (existingHotelName) {
            return res.status(409).json({
                success: false,
                message: `L'établissement "${existingHotelName}" est déjà enregistré.`
            });
        }

        for (const hotelDoc of allHotelsSnapshot.docs) {
            const configUserDoc = await hotelDoc.ref.collection('config').doc('users').get();
            if (configUserDoc.exists) {
                const configData = configUserDoc.data();
                if (Array.isArray(configData.users)) {
                    const exists = configData.users.some(u => (u.email || '').toLowerCase() === cleanEmail);
                    if (exists) {
                        return res.status(409).json({
                            success: false,
                            message: "Compte existant : connectez-vous ou utilisez un autre identifiant."
                        });
                    }
                }
            }
        }

        const hotelRef = await db.collection('hotels').add({
            name: cleanName,
            createdAt: new Date().toISOString()
        });

        const hotelId = hotelRef.id;

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password.trim(), salt);
        const adminId = 'usr_' + Date.now() + '_creator';

        const creatorAdminUser = {
            id: adminId,
            fullName: adminName.trim(),
            username: cleanEmail,
            username: cleanEmail,
            password: hashedPassword,
            passwordHash: hashedPassword,
            department: 'ADMIN',
            role: 'superadmin',
            isCreator: true,
            colorMark: 'red',
            createdBy: 'SYSTEM_REGISTER',
            createdAt: new Date().toISOString()
        };

        await db.collection('hotels').doc(hotelId).collection('config').doc('users').set({
            hotelId: hotelId,
            users: [creatorAdminUser],
            updatedAt: new Date().toISOString()
        });

        // 🌟 3. SAUVEGARDE DANS LE DOSSIER LOCAL RC-LOCALDATA AUTOMATIQUE
        saveToLocalMirror(hotelId, 'config', 'users', { hotelId, users: [creatorAdminUser] });
        saveToLocalMirror(hotelId, '_meta', 'info', { name: cleanName, hotelId });

        return res.json({
            success: true,
            message: 'Établissement et administrateur créés avec succès !',
            hotelId: hotelId,
            hotelName: cleanName
        });

    } catch (error) {
        console.error("Erreur enregistrement hôtel:", error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

// ==========================================
// 2. ROUTE UNIQUE DE LOGIN (Avec Gestion d'Échecs & Verrouillage)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { username, email, password } = req.body;
    const identifier = (username || email || '').trim().toLowerCase();

    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'Veuillez renseigner votre identifiant/email et votre mot de passe.' });
    }

    try {
        const hotelsSnapshot = await db.collection('hotels').get();
        let foundUser = null;
        let foundHotel = null;
        let userDocRef = null;

        for (const hotelDoc of hotelsSnapshot.docs) {
            const hotelId = hotelDoc.id;
            const hotelData = hotelDoc.data();
            
            const configUserDocRef = hotelDoc.ref.collection('config').doc('users');
            const configUserDoc = await configUserDocRef.get();
            
            if (configUserDoc.exists) {
                const configData = configUserDoc.data();
                
                saveToLocalMirror(hotelId, 'config', 'users', configData);
                saveToLocalMirror(hotelId, '_meta', 'info', hotelData);

                if (Array.isArray(configData.users)) {
                    const targetInConfig = configData.users.find(u => 
                        (u.username || '').trim().toLowerCase() === identifier ||
                        (u.email || '').trim().toLowerCase() === identifier
                    );

                    if (targetInConfig) {
                        foundUser = {
                            id: targetInConfig.id || targetInConfig.uid || targetInConfig.userId || ('usr_' + Date.now()),
                            ...targetInConfig
                        };
                        foundHotel = { id: hotelId, ...hotelData };
                        userDocRef = configUserDocRef;
                        break;
                    }
                }
            }
        }

        // --- MODE SECOURS LOCAL SI CLOUD INJOIGNABLE ---
        if (!foundUser) {
            console.warn("⚠️ Cloud injoignable ou utilisateur introuvable, tentative via le miroir RC-LOCALDATA...");
            const hotelsDir = path.join(LOCAL_DATA_ROOT, 'hotels');
            
            if (fs.existsSync(hotelsDir)) {
                const hotelDirs = fs.readdirSync(hotelsDir);
                for (const hId of hotelDirs) {
                    const localConfigUsers = readFromLocalMirror(hId, 'config', 'users');
                    const localInfo = readFromLocalMirror(hId, '_meta', 'info');

                    if (localConfigUsers && Array.isArray(localConfigUsers.users)) {
                        const targetInLocal = localConfigUsers.users.find(u => 
                            (u.username || '').trim().toLowerCase() === identifier ||
                            (u.email || '').trim().toLowerCase() === identifier
                        );

                        if (targetInLocal) {
                            foundUser = {
                                id: targetInLocal.id || ('usr_' + Date.now()),
                                ...targetInLocal
                            };
                            foundHotel = { id: hId, name: localInfo ? localInfo.name : 'Hôtel Local' };
                            break;
                        }
                    }
                }
            }
        }

        if (!foundUser) {
            return res.status(401).json({ success: false, message: 'Identifiant ou mot de passe incorrect.' });
        }

        // ==========================================
        // 🔒 GESTION DU BLOCAGE ET DES TENTATIVES
        // ==========================================
        const now = Date.now();
        const loginAttempts = foundUser.loginAttempts || { count: 0, lockoutUntil: null, finalLockout: false };

        // 1. Vérification si le compte est définitivement bloqué
        if (loginAttempts.finalLockout) {
            return res.status(403).json({
                success: false,
                message: "Compte bloqué suite à des échecs répétés. Veuillez demander une réinitialisation de votre mot de passe à votre administrateur."
            });
        }

        // 2. Vérification si le compte est en pause temporaire (15 min)
        if (loginAttempts.lockoutUntil && now < loginAttempts.lockoutUntil) {
            const remainingMinutes = Math.ceil((loginAttempts.lockoutUntil - now) / (60 * 1000));
            return res.status(429).json({
                success: false,
                message: `Trop de tentatives infructueuses. Compte temporairement verrouillé. Réessayez dans ${remainingMinutes} minute(s).`
            });
        } else if (loginAttempts.lockoutUntil && now >= loginAttempts.lockoutUntil) {
            // La pause de 15 minutes est passée, on réinitialise pour donner les 3 dernières chances
            loginAttempts.count = 5; // On considère qu'il a déjà consommé ses 5 premiers
            loginAttempts.lockoutUntil = null;
        }

        // ==========================================
        // 🔑 VÉRIFICATION DU MOT DE PASSE
        // ==========================================
        const storedPassword = foundUser.passwordHash || foundUser.password || '';
        let isPasswordCorrect = false;

        if (storedPassword.startsWith('$2')) {
            isPasswordCorrect = await bcrypt.compare(password.trim(), storedPassword);
        } else {
            isPasswordCorrect = (password.trim() === storedPassword);
        }

        // --- SI LE MOT DE PASSE EST INCORRECT ---
        if (!isPasswordCorrect) {
            loginAttempts.count += 1;

            // Cas A : 5 échecs -> Première pause de 15 minutes
            if (loginAttempts.count === 5) {
                loginAttempts.lockoutUntil = now + (5 * 60 * 1000); // 5 minutes
                await updateLoginAttemptsInDb(userDocRef, foundUser.id, loginAttempts, foundHotel.id);
                return res.status(429).json({
                    success: false,
                    message: "Mot de passe incorrect. 5 tentatives atteintes : votre compte est verrouillé pendant 5 minutes."
                });
            }

            // Cas B : Après la pause, 3 nouvelles chances (soit 8 échecs au total) -> Blocage définitif
            if (loginAttempts.count >= 8) {
                loginAttempts.finalLockout = true;
                await updateLoginAttemptsInDb(userDocRef, foundUser.id, loginAttempts, foundHotel.id);
                return res.status(403).json({
                    success: false,
                    message: "Trop d'échecs consécutifs après la période de pause. Votre compte est bloqué : veuillez demander une réinitialisation de votre mot de passe à votre administrateur."
                });
            }

            // Cas C : Échec simple avant d'atteindre les paliers
            await updateLoginAttemptsInDb(userDocRef, foundUser.id, loginAttempts, foundHotel.id);
            const attemptsLeft = loginAttempts.count < 5 ? (5 - loginAttempts.count) : (8 - loginAttempts.count);
            return res.status(401).json({
                success: false,
                message: `Identifiant ou mot de passe incorrect. Il vous reste ${attemptsLeft} tentative(s) avant verrouillage.`
            });
        }

        // --- SI LE CONNEXION EST RÉUSSIE : On remet les compteurs à zéro ---
loginAttempts.count = 0;
loginAttempts.lockoutUntil = null;
loginAttempts.finalLockout = false;
await updateLoginAttemptsInDb(userDocRef, foundUser.id, loginAttempts, foundHotel.id);

delete foundUser.passwordHash;
delete foundUser.password;
delete foundUser.loginAttempts;

// 🔐 Génération du jeton sécurisé infalsifiable lié à cette session
const sessionToken = crypto.randomBytes(32).toString('hex');

// On injecte le token directement dans l'objet utilisateur avant de l'enregistrer dans Firestore
foundUser.sessionToken = sessionToken;

// Récupération de tous les utilisateurs du document pour mettre à jour le tableau
const userDocSnap = await userDocRef.get();
if (userDocSnap.exists) {
    const data = userDocSnap.data();
    let usersArray = data.users || [];

    // On met à jour l'utilisateur spécifique dans le tableau avec son nouveau token
    usersArray = usersArray.map(u => {
        if (u.id === foundUser.id) {
            return { ...u, sessionToken: sessionToken };
        }
        return u;
    });

    // Sauvegarde persistante directement dans le document de l'hôtel
    await userDocRef.update({ users: usersArray });
}

delete foundUser.passwordHash;
delete foundUser.password;
delete foundUser.loginAttempts;

return res.json({
    success: true,
    token: sessionToken, // On envoie le token au client
    mustChangePassword: foundUser.isFirstLogin === true,
    user: foundUser,
    hotel: {
        id: foundHotel.id,
        name: foundHotel.name || 'Hôtel'
    }
});

    } catch (error) {
        console.error('Erreur Critique Login:', error);
        return res.status(500).json({ success: false, message: 'Erreur interne du serveur lors de la connexion.' });
    }
});

// Fonction utilitaire pour sauvegarder l'état des tentatives dans Firestore et en local
async function updateLoginAttemptsInDb(userDocRef, userId, loginAttemptsData, hotelId) {
    if (!userDocRef) return;
    try {
        const docSnap = await userDocRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            if (Array.isArray(data.users)) {
                data.users = data.users.map(u => {
                    if ((u.id || u.uid || u.userId) === userId || u.email === userId || u.username === userId) {
                        return { ...u, loginAttempts: loginAttemptsData };
                    }
                    return u;
                });
                data.updatedAt = new Date().toISOString();
                await userDocRef.set(data);
                saveToLocalMirror(hotelId, 'config', 'users', data);
            }
        }
    } catch (e) {
        console.error("Erreur mise à jour des tentatives de login:", e);
    }
}

app.post('/api/admin/login', (req, res) => {
    req.url = '/api/login';
    return app._router.handle(req, res);
});

// ==========================================
// 3. GESTION DES UTILISATEURS DANS CONFIG/USERS (Avec Miroir & Fallback)
// ==========================================

app.get('/api/admin/users', async (req, res) => {
    const { hotelId } = req.query;

    if (!hotelId) {
        return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });
    }

    try {
        const docSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('users').get();
        if (!docSnap.exists) {
            return res.json({ success: true, users: [] });
        }

        const configData = docSnap.data();
        
        // 🌟 Mise à jour du miroir local préventivement
        saveToLocalMirror(hotelId, 'config', 'users', configData);

        const usersList = (configData.users || []).map(u => {
            const copy = { ...u };
            delete copy.password;
            delete copy.passwordHash;
            return copy;
        });

        return res.json({ success: true, users: usersList });
    } catch (error) {
        console.warn('⚠️ Cloud injoignable, bascule sur le miroir RC-LOCALDATA pour les utilisateurs...');
        
        // 🌟 Secours local si le cloud tombe
        const localData = readFromLocalMirror(hotelId, 'config', 'users');
        if (localData && Array.isArray(localData.users)) {
            const usersList = localData.users.map(u => {
                const copy = { ...u };
                delete copy.password;
                delete copy.passwordHash;
                return copy;
            });
            return res.json({ success: true, users: usersList, source: 'RC-LOCALDATA-OFFLINE' });
        }

        return res.status(500).json({ success: false, message: 'Erreur serveur et données locales introuvables.' });
    }
});

app.post('/api/admin/users', async (req, res) => {
    try {
        const { hotelId, fullName, username, password, department, role, createdBy, isCreator, email } = req.body;

        if (!hotelId || !username || !password) {
            return res.status(400).json({ success: false, message: 'Données manquantes.' });
        }

        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        let currentUsers = [];
        if (docSnap.exists) {
            currentUsers = docSnap.data().users || [];
        }

        const cleanUsername = username.trim().toLowerCase();
        const cleanEmail = email ? email.trim().toLowerCase() : cleanUsername;

        // Vérification d'unicité basée sur le username ou l'email
        if (currentUsers.some(u => (u.username || '').toLowerCase() === cleanUsername || (u.email && u.email.toLowerCase() === cleanEmail))) {
            return res.status(409).json({ success: false, message: 'Un utilisateur avec cet identifiant ou cet e-mail existe déjà.' });
        }

        // Hachage du mot de passe
        const rawPassword = password.trim();
        let hashedPassword;
        if (!rawPassword.startsWith('$2a$') && !rawPassword.startsWith('$2b$') && !rawPassword.startsWith('$2y$')) {
            hashedPassword = await bcrypt.hash(rawPassword, 10);
        } else {
            hashedPassword = rawPassword;
        }

        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const isCreatorVal = !!isCreator;

        const newUser = {
            id: userId,
            fullName: fullName ? fullName.trim() : 'Utilisateur',
            username: cleanUsername,
            email: cleanEmail,
            password: hashedPassword,
            passwordHash: hashedPassword,
            department: department || 'IT',
            role: role || 'user',
            isCreator: isCreatorVal,
            isFirstLogin: true,
            colorMark: isCreatorVal ? 'red' : 'default',
            createdBy: createdBy || 'Superadmin',
            createdAt: new Date().toISOString()
        };

        currentUsers.push(newUser);

        const payloadToSave = {
            hotelId: hotelId,
            users: currentUsers,
            updatedAt: new Date().toISOString()
        };

        await configDocRef.set(payloadToSave, { merge: true });

        // 🌟 Sauvegarde immédiate dans le miroir local RC-LOCALDATA
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        const safeUser = { ...newUser };
        delete safeUser.password;
        delete safeUser.passwordHash;

        return res.status(201).json({ success: true, message: 'Utilisateur créé avec succès !', user: safeUser });
    } catch (error) {
        console.error('Erreur création utilisateur:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// ROUTES DE GESTION DES UTILISATEURS (Avec Miroir & Fallback Local)
// ==========================================

app.put('/api/admin/users/:id', async (req, res) => {
    const userId = req.params.id;
    const { hotelId, fullName, username, department, role } = req.body;

    if (!hotelId) {
        return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });
    }

    try {
        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Dossier utilisateurs introuvable.' });
        }

        let users = docSnap.data().users || [];
        const index = users.findIndex(u => u.id === userId);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Utilisateur non trouvé dans config/users.' });
        }

        users[index] = {
            ...users[index],
            fullName: fullName ? fullName.trim() : users[index].fullName,
            username: username ? username.trim().toLowerCase() : users[index].username,
            department: department || users[index].department,
            role: role || users[index].role,
            updatedAt: new Date().toISOString()
        };

        const payloadToSave = { hotelId, users, updatedAt: new Date().toISOString() };
        await configDocRef.update(payloadToSave);

        // 🌟 Synchro miroir local
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        return res.json({ success: true, message: 'Utilisateur mis à jour avec succès !' });
    } catch (error) {
        console.error('Erreur mise à jour utilisateur:', error);
        
        // --- SECOURS LOCAL ---
        const localData = readFromLocalMirror(hotelId, 'config', 'users');
        if (localData && Array.isArray(localData.users)) {
            const index = localData.users.findIndex(u => u.id === userId);
            if (index !== -1) {
                localData.users[index] = {
                    ...localData.users[index],
                    fullName: fullName ? fullName.trim() : localData.users[index].fullName,
                    username: username ? username.trim().toLowerCase() : localData.users[index].username,
                    department: department || localData.users[index].department,
                    role: role || localData.users[index].role,
                    updatedAt: new Date().toISOString()
                };
                saveToLocalMirror(hotelId, 'config', 'users', localData);
                return res.json({ success: true, message: 'Utilisateur mis à jour (Mode Hors-ligne RC-LOCALDATA)' });
            }
        }

        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/users/reset-password', async (req, res) => {
    let { hotelId, targetUserId, newPassword, requesterId, token } = req.body;

    // 🌟 Si on arrive via un token de réinitialisation e-mail, on valide le token et on extrait les IDs automatiquement
    if (token && hotelId) {
        try {
            const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordResets');
            const reqDocSnap = await reqDocRef.get();
            let resets = reqDocSnap.exists ? (reqDocSnap.data().resets || []) : [];
            
            const activeReset = resets.find(r => r.token === token && r.expiresAt > Date.now());
            if (!activeReset) {
                return res.json({ success: false, message: 'Lien de réinitialisation invalide or expiré.' });
            }

            targetUserId = activeReset.userId;
            requesterId = activeReset.userId; // Bypass de la vérification admin puisqu'il a cliqué sur son lien e-mail sécurisé
        } catch (err) {
            console.error("Erreur validation token:", err);
            return res.json({ success: false, message: 'Erreur lors de la validation du token.' });
        }
    }

    if (!hotelId || !targetUserId || !newPassword || newPassword.trim() === '' || !requesterId) {
        return res.json({ success: false, message: 'Paramètres manquants pour la réinitialisation.' });
    }

    try {
        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        if (!docSnap.exists) {
            return res.json({ success: false, message: 'Dossier utilisateurs introuvable.' });
        }

        let users = docSnap.data().users || [];

        // Si ce n'est pas un reset par token e-mail, on vérifie que le demandeur est admin
        if (!token) {
            const requester = users.find(u => u.id === requesterId || u.uid === requesterId || u.username === requesterId || u.email === requesterId);
            const rawRole = requester ? (requester.role || requester.roles || '') : '';
            const rolesArray = typeof rawRole === 'string' ? rawRole.split(',').map(r => r.trim().toLowerCase()) : Array.isArray(rawRole) ? rawRole.map(r => String(r).trim().toLowerCase()) : [];
            const isRequesterSuperAdmin = rolesArray.includes('superadmin') || rolesArray.includes('admin') || rolesArray.includes('it');

            if (!requester || !isRequesterSuperAdmin) {
                return res.json({ success: false, message: "Vous n'êtes pas autorisé à modifier les mots de passe." });
            }
        }

        const index = users.findIndex(u => u.id === targetUserId);
        if (index === -1) {
            return res.json({ success: false, message: 'Utilisateur introuvable.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
        const nowIso = new Date().toISOString();

        users[index].password = hashedPassword;
        users[index].passwordHash = hashedPassword;
        users[index].isFirstLogin = false; 
        users[index].updatedAt = nowIso;
        users[index].passwordUpdatedAt = nowIso;
        
        users[index].loginAttempts = {
            count: 0,
            finalLockout: false,
            lockoutUntil: null
        };

        const payloadToSave = { hotelId, users, updatedAt: nowIso };
        await configDocRef.update(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        // 🧹 Nettoyage du token utilisé s'il y en a un
        if (token) {
            const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordResets');
            const reqDocSnap = await reqDocRef.get();
            if (reqDocSnap.exists) {
                let resets = reqDocSnap.data().resets || [];
                resets = resets.filter(r => r.token !== token);
                await reqDocRef.set({ resets, updatedAt: nowIso });
                saveToLocalMirror(hotelId, 'config', 'passwordResets', { resets });
            }
        }

        return res.json({ success: true, message: 'Mot de passe réinitialisé et compte débloqué avec succès !' });
    } catch (error) {
        console.error("Erreur reset-password:", error);
        return res.json({ success: false, message: 'Une erreur serveur est survenue.' });
    }
});

app.get('/api/hotels/:hotelId/password-requests', async (req, res) => {
    try {
        const { hotelId } = req.params;
        
        const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordRequests');
        const reqDocSnap = await reqDocRef.get();

        if (!reqDocSnap.exists) {
            // Tenter le miroir local
            const localReqs = readFromLocalMirror(hotelId, 'config', 'passwordRequests');
            if (localReqs && localReqs.requests) {
                return res.status(200).json(localReqs.requests);
            }
            return res.status(200).json([]);
        }

        const reqData = reqDocSnap.data();
        saveToLocalMirror(hotelId, 'config', 'passwordRequests', reqData);

        const requests = reqData.requests || [];
        return res.status(200).json(requests);
    } catch (error) {
        console.error("Erreur récupération password-requests:", error);
        
        // Secours local
        const localReqs = readFromLocalMirror(hotelId, 'config', 'passwordRequests');
        if (localReqs && localReqs.requests) {
            return res.status(200).json(localReqs.requests);
        }

        return res.status(500).json({ error: "Erreur serveur" });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    const userId = req.params.id;
    const { hotelId } = req.body;

    if (!hotelId) {
        return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });
    }

    try {
        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Dossier utilisateurs introuvable.' });
        }

        let users = docSnap.data().users || [];
        const updatedUsers = users.filter(u => u.id !== userId);

        const payloadToSave = { hotelId, users: updatedUsers, updatedAt: new Date().toISOString() };
        await configDocRef.update(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        return res.json({ success: true, message: 'Utilisateur supprimé avec succès !' });
    } catch (error) {
        console.error('Erreur suppression utilisateur:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config/users', async (req, res) => {
    try {
        const { hotelId, users, createdBy } = req.body;

        if (!hotelId || !users || !Array.isArray(users)) {
            return res.status(400).json({ success: false, error: 'Données invalides ou liste utilisateurs absente.' });
        }

        const docRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await docRef.get();
        const existingUsers = docSnap.exists ? (docSnap.data().users || []) : [];

        // Traitement de chaque utilisateur de l'import Excel
        const processedUsers = await Promise.all(users.map(async (user, index) => {
            const cleanUsername = (user.username || user.email || '').trim().toLowerCase();
            const cleanEmail = user.email ? user.email.trim().toLowerCase() : cleanUsername;

            // Cherche si cet utilisateur existe déjà en base
            const existingUser = existingUsers.find(u => 
                (u.email && cleanEmail && u.email.toLowerCase() === cleanEmail) || 
                (u.id && user.id && u.id === user.id) ||
                (u.username && cleanUsername && u.username.toLowerCase() === cleanUsername)
            );

            let hashedPassword;
            let isFirstLoginVal;

            if (existingUser) {
                const rawPassword = user.password || user.pass;
                if (rawPassword && !rawPassword.startsWith('$2a$') && !rawPassword.startsWith('$2b$') && !rawPassword.startsWith('$2y$')) {
                    hashedPassword = await bcrypt.hash(rawPassword.trim(), 10);
                    isFirstLoginVal = true;
                } else {
                    hashedPassword = existingUser.password || existingUser.passwordHash;
                    // S'il existe déjà, on garde sa valeur, sinon on met true par défaut
                    isFirstLoginVal = existingUser.isFirstLogin !== undefined ? existingUser.isFirstLogin : true;
                }
            } else {
                const rawPassword = user.password || user.pass || '123456';
                if (!rawPassword.startsWith('$2a$') && !rawPassword.startsWith('$2b$') && !rawPassword.startsWith('$2y$')) {
                    hashedPassword = await bcrypt.hash(rawPassword.trim(), 10);
                } else {
                    hashedPassword = rawPassword;
                }
                isFirstLoginVal = true;
            }

            const isCreatorVal = existingUser ? existingUser.isCreator : !!user.isCreator;

            return {
                ...user,
                id: existingUser ? existingUser.id : (user.id || ('usr_' + Date.now() + '_' + index + '_' + Math.random().toString(36).substr(2, 4))),
                fullName: user.fullName ? user.fullName.trim() : (existingUser?.fullName || 'Utilisateur'),
                username: cleanUsername,
                email: cleanEmail.includes('@') ? cleanEmail : `${cleanEmail}@hotel.com`,
                password: hashedPassword,
                passwordHash: hashedPassword,
                department: user.department || existingUser?.department || 'IT',
                role: user.role || existingUser?.role || 'user',
                isCreator: isCreatorVal,
                isFirstLogin: isFirstLoginVal, // 🌟 GARANTI PRÉSENT
                colorMark: isCreatorVal ? 'red' : (user.colorMark || existingUser?.colorMark || 'default'),
                createdBy: user.createdBy || existingUser?.createdBy || createdBy || 'Superadmin',
                createdAt: existingUser?.createdAt || user.createdAt || new Date().toISOString()
            };
        }));

        // 🌟 CORRECTION MAJEURE ICI : On s'assure que les anciens utilisateurs non présents dans l'Excel 
        // récupèrent aussi un isFirstLogin s'ils ne l'avaient pas, et on intègre proprement les processedUsers.
        const finalUsersMap = new Map();

        // 1. D'abord on traite les existants en s'assurant qu'ils ont le champ isFirstLogin
        existingUsers.forEach(u => {
            const key = (u.email || u.username || u.id || '').toLowerCase();
            if (key) {
                finalUsersMap.set(key, {
                    ...u,
                    isFirstLogin: u.isFirstLogin !== undefined ? u.isFirstLogin : false
                });
            }
        });

        // 2. Ensuite on écrase/ajoute avec les utilisateurs traités de l'Excel (qui ont leur isFirstLogin calculé)
        processedUsers.forEach(pUser => {
            const key = (pUser.email || pUser.username || pUser.id || '').toLowerCase();
            if (key) finalUsersMap.set(key, pUser);
        });

        const finalUsers = Array.from(finalUsersMap.values());

        const payloadToSave = {
            hotelId,
            users: finalUsers,
            updatedAt: new Date().toISOString()
        };

        await docRef.set(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        res.json({ success: true, message: 'Importation fusionnée et enregistrée avec succès', users: finalUsers });
    } catch (error) {
        console.error("Erreur import users:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/admin/config/user-update', async (req, res) => {
    try {
        const { hotelId, userId, updateData } = req.body;

        if (!hotelId || !userId || !updateData) {
            return res.status(400).json({ error: 'Données invalides pour la mise à jour.' });
        }

        const docRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await docRef.get();
        
        if (!docSnap.exists) {
            return res.status(404).json({ error: 'Document utilisateurs introuvable.' });
        }

        let users = docSnap.data().users || [];
        const userIndex = users.findIndex(u => u.id === userId);

        if (userIndex === -1) {
            return res.status(404).json({ error: 'Utilisateur introuvable dans la liste.' });
        }

        users[userIndex] = {
            ...users[userIndex],
            ...updateData,
            updatedAt: new Date().toISOString()
        };

        const payloadToSave = {
            hotelId,
            users: users,
            updatedAt: new Date().toISOString()
        };

        await docRef.set(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        res.json({ message: 'Utilisateur mis à jour avec succès', users: users });
    } catch (error) {
        console.error("Erreur mise à jour utilisateur unique:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. AUTRES CONFIGURATIONS (Avec Miroir & Fallback)
// ==========================================
app.get('/api/admin/config/roles', async (req, res) => {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const docSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('roles').get();
        if (!docSnap.exists) {
            const localRoles = readFromLocalMirror(hotelId, 'config', 'roles');
            if (localRoles) return res.json({ success: true, ...localRoles });
            return res.json({ success: true, roles: [] });
        }
        const data = docSnap.data();
        saveToLocalMirror(hotelId, 'config', 'roles', data);
        return res.json({ success: true, ...data });
    } catch (error) {
        const localRoles = readFromLocalMirror(hotelId, 'config', 'roles');
        if (localRoles) return res.json({ success: true, ...localRoles, source: 'RC-LOCALDATA-OFFLINE' });
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config/roles', async (req, res) => {
    const { hotelId, roles } = req.body;
    if (!hotelId || !Array.isArray(roles)) return res.status(400).json({ success: false, message: 'Données invalides.' });

    try {
        const payloadToSave = {
            roles: roles,
            updatedAt: new Date().toISOString()
        };
        await db.collection('hotels').doc(hotelId).collection('config').doc('roles').set(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'roles', payloadToSave);
        return res.json({ success: true, message: 'Rôles enregistrés avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/config/structure', async (req, res) => {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const docSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('structure').get();
        if (!docSnap.exists) {
            const localStructure = readFromLocalMirror(hotelId, 'config', 'structure');
            if (localStructure) return res.json({ success: true, ...localStructure });
            return res.json({ success: true, floors: {} });
        }
        const data = docSnap.data();
        saveToLocalMirror(hotelId, 'config', 'structure', data);
        return res.json({ success: true, ...data });
    } catch (error) {
        const localStructure = readFromLocalMirror(hotelId, 'config', 'structure');
        if (localStructure) return res.json({ success: true, ...localStructure, source: 'RC-LOCALDATA-OFFLINE' });
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config/structure', async (req, res) => {
    const { hotelId, floors } = req.body;
    if (!hotelId || !floors) return res.status(400).json({ success: false, message: 'Données invalides.' });

    try {
        const payloadToSave = {
            hotelId: hotelId,
            floors: floors,
            updatedAt: new Date().toISOString()
        };
        await db.collection('hotels').doc(hotelId).collection('config').doc('structure').set(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'structure', payloadToSave);
        return res.json({ success: true, message: 'Structure enregistrée avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. GESTION DES TICKETS (Avec Miroir & Fallback)
// ==========================================
app.get('/api/tickets', async (req, res) => {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const snapshot = await db.collection('hotels').doc(hotelId).collection('tickets').get();
        const tickets = [];
        snapshot.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
        
        // 🌟 Sauvegarde miroir globale des tickets de l'hôtel
        saveToLocalMirror(hotelId, 'tickets', 'all_tickets', { tickets });
        return res.json({ success: true, tickets });
    } catch (error) {
        // Secours local
        const localTicketsData = readFromLocalMirror(hotelId, 'tickets', 'all_tickets');
        if (localTicketsData && Array.isArray(localTicketsData.tickets)) {
            return res.json({ success: true, tickets: localTicketsData.tickets, source: 'RC-LOCALDATA-OFFLINE' });
        }
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/tickets', async (req, res) => {
    const { hotelId, floor, room, equipment, priority, description, author, createdBy, department } = req.body;
    if (!hotelId || !room || !equipment || !description) return res.status(400).json({ success: false, message: 'Champs requis manquants.' });

    try {
        const nowIso = new Date().toISOString();
        const creatorName = createdBy || author || 'Anonyme';

        const newTicket = {
            floor: parseInt(floor) || 0,
            room: room.trim(),
            equipment: equipment.trim(),
            priority: priority || 'Moyenne',
            description: description.trim(),
            author: author || creatorName,
            createdBy: creatorName,
            resolvedBy: null,
            department: department || '',
            status: 'Ouvert',
            createdAt: nowIso,
            startedAt: null,
            resolvedAt: null,
            workDone: '',
            resolutionTime: null
        };

        const docRef = await db.collection('hotels').doc(hotelId).collection('tickets').add(newTicket);
        const ticketWithId = { id: docRef.id, ...newTicket };

        // 🌟 Mettre à jour le miroir local des tickets
        const localTicketsData = readFromLocalMirror(hotelId, 'tickets', 'all_tickets') || { tickets: [] };
        localTicketsData.tickets.push(ticketWithId);
        saveToLocalMirror(hotelId, 'tickets', 'all_tickets', localTicketsData);

        return res.json({ success: true, id: docRef.id, ticket: ticketWithId, message: 'Ticket créé avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/tickets/:id/status', async (req, res) => {
    const ticketId = req.params.id;
    const { hotelId, status, userName, userRole, workDone } = req.body;

    if (!hotelId || !status) return res.status(400).json({ success: false, message: 'ID hôtel et statut requis.' });

    try {
        const ticketRef = db.collection('hotels').doc(hotelId).collection('tickets').doc(ticketId);
        const doc = await ticketRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });

        const ticket = doc.data();
        const now = new Date();
        const nowIso = now.toISOString();
        let updateData = { status, updatedAt: nowIso };

        if (status === 'En cours') {
            if (!ticket.startedAt) updateData.startedAt = nowIso;
        } else if (status === 'Résolu') {
            updateData.resolvedBy = userName || 'Technicien';
            updateData.workDone = workDone || 'Résolution confirmée';
            updateData.resolvedAt = nowIso;

            const start = ticket.startedAt ? new Date(ticket.startedAt) : new Date(ticket.createdAt || nowIso);
            const diffMs = now - start;
            const diffMins = Math.max(1, Math.round(diffMs / 60000));
            updateData.resolutionTime = diffMins < 60 ? `${diffMins} min` : `${Math.floor(diffMins / 60)}h ${diffMins % 60}min`;
        }

        await ticketRef.update(updateData);

        // Mettre à jour le miroir local
        const localTicketsData = readFromLocalMirror(hotelId, 'tickets', 'all_tickets');
        if (localTicketsData && Array.isArray(localTicketsData.tickets)) {
            const tIndex = localTicketsData.tickets.findIndex(t => t.id === ticketId);
            if (tIndex !== -1) {
                localTicketsData.tickets[tIndex] = { ...localTicketsData.tickets[tIndex], ...updateData };
                saveToLocalMirror(hotelId, 'tickets', 'all_tickets', localTicketsData);
            }
        }

        return res.json({ success: true, message: 'Statut mis à jour !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/tickets/:id', async (req, res) => {
    const ticketId = req.params.id;
    const { hotelId } = req.body;

    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const ticketRef = db.collection('hotels').doc(hotelId).collection('tickets').doc(ticketId);
        const doc = await ticketRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });

        await ticketRef.delete();

        // Mettre à jour le miroir local
        const localTicketsData = readFromLocalMirror(hotelId, 'tickets', 'all_tickets');
        if (localTicketsData && Array.isArray(localTicketsData.tickets)) {
            localTicketsData.tickets = localTicketsData.tickets.filter(t => t.id !== ticketId);
            saveToLocalMirror(hotelId, 'tickets', 'all_tickets', localTicketsData);
        }

        return res.json({ success: true, message: 'Ticket supprimé avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// --- ROUTE PUBLIQUE (Avec secours hors-ligne RC-LOCALDATA et journalisation détaillée) ---
app.post('/api/public-action', async (req, res) => {
    const { action, dataPayload } = req.body;
    console.log(`[Public-Action] Action reçue : ${action}`, { dataPayload });

    // Action : Récupération du nom de l'utilisateur
    if (action === 'GET_USER_NAME') {
        try {
            const identifier = dataPayload?.identifier?.trim().toLowerCase();
            console.log(`[GET_USER_NAME] Recherche pour l'identifiant : "${identifier}"`);

            const hotelsSnapshot = await db.collection('hotels').get();
            let foundFullName = null;

            for (const hotelDoc of hotelsSnapshot.docs) {
                const hotelId = hotelDoc.id;
                const userDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
                const userDocSnap = await userDocRef.get();
                
                let usersList = [];
                if (userDocSnap.exists) {
                    const data = userDocSnap.data();
                    usersList = Array.isArray(data.users) ? data.users : Object.values(data);
                    saveToLocalMirror(hotelId, 'config', 'users', data);
                    console.log(`[GET_USER_NAME] [Hotel: ${hotelId}] Utilisateurs récupérés depuis Firestore.`);
                } else {
                    console.log(`[GET_USER_NAME] [Hotel: ${hotelId}] Document Firestore absent, tentative de lecture du miroir local...`);
                    const localData = readFromLocalMirror(hotelId, 'config', 'users');
                    if (localData && Array.isArray(localData.users)) {
                        usersList = localData.users;
                        console.log(`[GET_USER_NAME] [Hotel: ${hotelId}] Utilisateurs récupérés depuis le miroir local.`);
                    }
                }

                const matchedUser = usersList.find(u => 
                    u && typeof u === 'object' && (
                        (u.email && u.email.trim().toLowerCase() === identifier) || 
                        (u.username && u.username.trim().toLowerCase() === identifier)
                    )
                );

                if (matchedUser) {
                    foundFullName = matchedUser.fullName || matchedUser.displayName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim();
                    console.log(`[GET_USER_NAME] Utilisateur trouvé dans l'hôtel ${hotelId} :`, foundFullName);
                    break;
                }
            }

            if (foundFullName) {
                return res.json({ success: true, fullName: foundFullName });
            } else {
                console.log(`[GET_USER_NAME] Utilisateur non trouvé pour l'identifiant : "${identifier}" dans Firestore.`);
                return res.json({ success: false, message: "Utilisateur non trouvé" });
            }
        } catch (err) {
            console.error(`[GET_USER_NAME] Erreur Firestore, basculement en mode hors-ligne global :`, err);
            const hotelsDir = path.join(LOCAL_DATA_ROOT, 'hotels');
            const identifier = dataPayload?.identifier?.trim().toLowerCase();
            let foundFullName = null;

            if (fs.existsSync(hotelsDir)) {
                const hotelDirs = fs.readdirSync(hotelsDir);
                for (const hId of hotelDirs) {
                    const localData = readFromLocalMirror(hId, 'config', 'users');
                    if (localData && Array.isArray(localData.users)) {
                        const matchedUser = localData.users.find(u => 
                            u && typeof u === 'object' && (
                                (u.email && u.email.trim().toLowerCase() === identifier) || 
                                (u.username && u.username.trim().toLowerCase() === identifier)
                            )
                        );
                        if (matchedUser) {
                            foundFullName = matchedUser.fullName || matchedUser.displayName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim();
                            console.log(`[GET_USER_NAME] [OFFLINE] Utilisateur trouvé dans l'hôtel ${hId} (miroir) :`, foundFullName);
                            break;
                        }
                    }
                }
            }

            if (foundFullName) {
                return res.json({ success: true, fullName: foundFullName, source: 'RC-LOCALDATA-OFFLINE' });
            }
            console.warn(`[GET_USER_NAME] [OFFLINE] Données locales introuvables pour : "${identifier}"`);
            return res.status(500).json({ success: false, message: "Erreur serveur et données locales introuvables" });
        }
    }

    // Action : Demande de réinitialisation de mot de passe par e-mail avec Token sécurisé
    if (action === 'REQUEST_PASSWORD_RESET') {
        try {
            const identifier = dataPayload?.identifier?.trim().toLowerCase();
            console.log(`[REQUEST_PASSWORD_RESET] Demande reçue pour l'identifiant : "${identifier}"`);

            if (!identifier) {
                console.warn(`[REQUEST_PASSWORD_RESET] Identifiant manquant dans le payload.`);
                return res.json({ success: false, message: "Identifiant manquant." });
            }

            const hotelsSnapshot = await db.collection('hotels').get();
            let targetHotelId = null;
            let matchedUser = null;

            for (const hotelDoc of hotelsSnapshot.docs) {
                const hotelId = hotelDoc.id;
                const userDocSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('users').get();
                
                let usersList = [];
                if (userDocSnap.exists) {
                    const data = userDocSnap.data();
                    usersList = Array.isArray(data.users) ? data.users : Object.values(data);
                    saveToLocalMirror(hotelId, 'config', 'users', data);
                } else {
                    const localData = readFromLocalMirror(hotelId, 'config', 'users');
                    if (localData && Array.isArray(localData.users)) {
                        usersList = localData.users;
                    }
                }
                
                matchedUser = usersList.find(u => 
                    u && typeof u === 'object' && (
                        (u.email && u.email.trim().toLowerCase() === identifier) || 
                        (u.username && u.username.trim().toLowerCase() === identifier)
                    )
                );

                if (matchedUser) {
                    targetHotelId = hotelId;
                    console.log(`[REQUEST_PASSWORD_RESET] Utilisateur ciblé trouvé dans l'hôtel : ${hotelId}`);
                    break;
                }
            }

            const userIdentifier = matchedUser ? (matchedUser.email || matchedUser.username) : null;
            const primaryUserId = matchedUser ? (matchedUser.id || matchedUser.uid) : null;

            if (!matchedUser || !targetHotelId || !userIdentifier) {
                console.warn(`[REQUEST_PASSWORD_RESET] Aucun compte ne correspond à l'identifiant : "${identifier}". Réponse neutre renvoyée par sécurité.`);
                return res.json({ success: true, message: "Si le compte existe, un e-mail a été envoyé." });
            }

            const crypto = require('crypto');
            const resetToken = crypto.randomBytes(32).toString('hex');
            const tokenExpiration = Date.now() + 1800000; // +30 minutes (contre le délai de la sandbox Trend Micro)

            // 1. Enregistrement pour la vérification du token (passwordResets)
            const resetDocRef = db.collection('hotels').doc(targetHotelId).collection('config').doc('passwordResets');
            const resetDocSnap = await resetDocRef.get();
            let resets = resetDocSnap.exists ? (resetDocSnap.data().resets || []) : [];

            resets = resets.filter(r => r.userId !== primaryUserId);
            resets.push({
                userId: primaryUserId,
                email: userIdentifier,
                token: resetToken,
                expiresAt: tokenExpiration,
                createdAt: new Date().toISOString()
            });
            await resetDocRef.set({ resets, updatedAt: new Date().toISOString() });
            saveToLocalMirror(targetHotelId, 'config', 'passwordResets', { resets });
            console.log(`[REQUEST_PASSWORD_RESET] Token de réinitialisation enregistré pour l'utilisateur ID: ${primaryUserId}`);

            // 2. Enregistrement pour la notification admin (passwordRequests)
            const reqDocRef = db.collection('hotels').doc(targetHotelId).collection('config').doc('passwordRequests');
            const reqDocSnap = await reqDocRef.get();
            let requests = reqDocSnap.exists ? (reqDocSnap.data().requests || []) : [];

            requests = requests.filter(r => r.userId !== primaryUserId && r.identifier?.toLowerCase() !== userIdentifier.toLowerCase());
            requests.push({
                userId: primaryUserId,
                identifier: userIdentifier,
                fullName: matchedUser.fullName || matchedUser.displayName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim() || matchedUser.username,
                createdAt: new Date().toISOString()
            });

            const requestPayload = { requests, updatedAt: new Date().toISOString() };
            await reqDocRef.set(requestPayload);
            saveToLocalMirror(targetHotelId, 'config', 'passwordRequests', requestPayload);
            console.log(`[REQUEST_PASSWORD_RESET] Notification de demande de mot de passe ajoutée pour l'admin.`);

            const origin = req.headers.origin || req.headers.referer || '';
            let frontendBaseUrl = 'http://localhost:3000';

            if (origin.includes('centillion.online') || process.env.NODE_ENV === 'production') {
                frontendBaseUrl = 'https://roomcheck.centillion.online';
            }

            const resetLink = `${frontendBaseUrl}/login.html?reset=true&token=${resetToken}&hotelId=${targetHotelId}`;

            // 🚀 Envoi de l'e-mail via l'API HTTP de Brevo (Port 443 - Non bloqué par Render) avec ton template d'origine
            const userName = matchedUser.fullName || matchedUser.displayName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim() || matchedUser.username || 'Utilisateur';

            const htmlContent = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                    
                    <!-- En-tête centré avec un vrai centrage parfait du logo -->
                    <div style="background-color: #0f172a; padding: 25px 20px; text-align: center;">
                        <table align="center" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                            <tr>
                                <td style="vertical-align: middle; text-align: center;">
                                    <div style="background-color: #ffffff; width: 44px; height: 44px; border-radius: 10px; display: inline-block; vertical-align: middle; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center;">
                                        <!-- Table interne pour forcer le centrage parfait vertical et horizontal -->
                                        <table width="100%" height="44" cellpadding="0" cellspacing="0">
                                            <tr>
                                                <td align="center" valign="middle" style="height: 44px; line-height: 44px;">
                                                    <img src="https://roomcheck.centillion.online/IT_RoomCheck.png" alt="Logo" style="width: 32px; height: 32px; display: block; margin: 0 auto;" />
                                                </td>
                                            </tr>
                                        </table>
                                    </div>
                                </td>
                                <td style="vertical-align: middle; padding-left: 14px; text-align: left;">
                                    <span style="color: #ffffff; font-size: 20px; font-weight: bold; font-family: Arial, sans-serif; display: inline-block; vertical-align: middle;">RoomCheck Security</span>
                                </td>
                            </tr>
                        </table>
                    </div>

                    <!-- Corps du message -->
                    <div style="padding: 30px 25px;">
                        <p style="color: #334155; font-size: 15px; line-height: 1.5; margin-top: 0;">Bonjour <strong>${userName}</strong>,</p>
                        <p style="color: #334155; font-size: 15px; line-height: 1.5;">Une demande de réinitialisation de mot de passe a été effectuée pour votre compte.</p>
                        <p style="color: #334155; font-size: 15px; line-height: 1.5;">Ce lien est sécurisé et valide pendant <strong>30 minutes</strong> :</p>
                        
                        <!-- Bouton d'action -->
                        <div style="text-align: center; margin: 35px 0;">
                            <a href="${resetLink}" style="background-color: #0d9488; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 6px rgba(13, 148, 136, 0.2);">Réinitialiser mon mot de passe</a>
                        </div>
                        
                        <!-- Avertissement -->
                        <p style="font-size: 13px; color: #64748b; text-align: center; line-height: 1.4; margin-top: 25px;">Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.</p>
                        
                        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;">
                        
                        <!-- Pied de page -->
                        <p style="font-size: 12px; color: #94a3b8; text-align: center; font-weight: bold; letter-spacing: 0.5px; margin: 0;">RoomCheck - Centillion.Online</p>
                    </div>
                </div>
            `;

            const textContent = `Bonjour ${userName},\n\nUne demande de réinitialisation de mot de passe a été effectuée pour votre compte.\n\nCopiez ce lien pour réinitialiser votre mot de passe (valide 30 minutes) :\n${resetLink}\n\nSi vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.\n\nRoomCheck - Centillion.Online`;

            const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'api-key': process.env.BREVO_SMTP_PASS,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    sender: {
                        name: "RoomCheck Sécurité",
                        email: "noreply@centillion.online"
                    },
                    to: [{ email: userIdentifier }],
                    subject: "Réinitialisation de votre mot de passe - RoomCheck",
                    htmlContent: htmlContent,
                    textContent: textContent
                })
            });

            if (!brevoResponse.ok) {
                const errorData = await brevoResponse.json();
                console.error(`[REQUEST_PASSWORD_RESET] Erreur API Brevo:`, errorData);
                return res.status(500).json({ success: false, message: "Échec de l'envoi de l'e-mail de réinitialisation." });
            }

            console.log(`[REQUEST_PASSWORD_RESET] E-mail de réinitialisation envoyé avec succès via l'API Brevo à : ${userIdentifier}`);
            return res.json({ success: true, message: "E-mail de réinitialisation envoyé avec succès." });
        } catch (err) {
            console.error(`[REQUEST_PASSWORD_RESET] Erreur lors de la demande de réinitialisation :`, err);
            return res.status(500).json({ success: false, message: "Erreur serveur" });
        }
    }

    // --- Action : Vérification du token de réinitialisation e-mail ---
    if (action === 'VERIFY_RESET_TOKEN') {
        try {
            const { token, hotelId } = dataPayload || {};
            console.log(`[VERIFY_RESET_TOKEN] Vérification du token pour l'hôtel ID: ${hotelId}`);

            if (!token || !hotelId) {
                console.warn(`[VERIFY_RESET_TOKEN] Paramètres manquants (token ou hotelId).`);
                return res.json({ success: false, message: "Paramètres manquants." });
            }

            const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordResets');
            const reqDocSnap = await reqDocRef.get();
            
            let resets = [];
            if (reqDocSnap.exists) {
                resets = reqDocSnap.data().resets || [];
            } else {
                const localData = readFromLocalMirror(hotelId, 'config', 'passwordResets');
                if (localData && Array.isArray(localData.resets)) {
                    resets = localData.resets;
                }
            }

            const activeReset = resets.find(r => r.token === token && r.expiresAt > Date.now());
            if (!activeReset) {
                console.warn(`[VERIFY_RESET_TOKEN] Token invalide ou expiré.`);
                return res.json({ success: false, message: "Lien de réinitialisation invalide ou expiré." });
            }

            const userDocSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('users').get();
            let usersList = [];
            if (userDocSnap.exists) {
                const data = userDocSnap.data();
                usersList = Array.isArray(data.users) ? data.users : Object.values(data);
                saveToLocalMirror(hotelId, 'config', 'users', data);
            } else {
                const localData = readFromLocalMirror(hotelId, 'config', 'users');
                if (localData && Array.isArray(localData.users)) {
                    usersList = localData.users;
                }
            }

            const matchedUser = usersList.find(u => {
                if (!u) return false;
                const uId = u.id || u.uid;
                const uEmail = (u.email || u.username || '').toLowerCase();
                return (activeReset.userId && uId === activeReset.userId) || 
                       (activeReset.email && uEmail === activeReset.email.toLowerCase());
            });
            
            if (!matchedUser) {
                console.warn(`[VERIFY_RESET_TOKEN] Utilisateur associé au token introuvable dans l'hôtel.`);
                return res.json({ success: false, message: "Utilisateur introuvable." });
            }

            const userId = matchedUser.id || matchedUser.uid;
            const fullName = matchedUser.fullName || matchedUser.displayName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim() || matchedUser.username || 'Collaborateur';

            console.log(`[VERIFY_RESET_TOKEN] Token valide pour l'utilisateur : ${fullName} (${userId})`);
            return res.json({ 
                success: true, 
                userId: userId, 
                fullName: fullName 
            });

        } catch (err) {
            console.error(`[VERIFY_RESET_TOKEN] Erreur serveur lors de la vérification du token :`, err);
            return res.status(500).json({ success: false, message: "Erreur serveur" });
        }
    }

    // --- Action : Mise à jour effective du mot de passe et nettoyage multi-critères ---
    if (action === 'UPDATE_PASSWORD') {
        try {
            const { token, hotelId, newPassword } = dataPayload || {};
            console.log(`[UPDATE_PASSWORD] Tentative de mise à jour du mot de passe pour l'hôtel ID: ${hotelId}`);
            
            if (!token || !hotelId || !newPassword) {
                console.warn(`[UPDATE_PASSWORD] Paramètres manquants pour la mise à jour.`);
                return res.json({ success: false, message: "Paramètres manquants pour la mise à jour." });
            }

            // 1. Vérifier le token dans passwordResets
            const resetDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordResets');
            const resetDocSnap = await resetDocRef.get();
            let resets = resetDocSnap.exists ? (resetDocSnap.data().resets || []) : [];

            const activeReset = resets.find(r => r.token === token && r.expiresAt > Date.now());
            if (!activeReset) {
                console.warn(`[UPDATE_PASSWORD] Jeton de réinitialisation invalide ou expiré.`);
                return res.json({ success: false, message: "Jeton de réinitialisation invalide ou expiré." });
            }

            const targetUserId = activeReset.userId;
            const targetEmail = activeReset.email ? activeReset.email.toLowerCase() : null;

            // 2. Hasher le nouveau mot de passe avec bcrypt
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash(newPassword, 10);

            // 3. Mettre à jour le tableau des utilisateurs dans Firestore
            const usersDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
            const usersDocSnap = await usersDocRef.get();

            let matchedUserEmail = null;
            if (usersDocSnap.exists) {
                const data = usersDocSnap.data();
                let usersList = Array.isArray(data.users) ? data.users : Object.values(data);

                usersList = usersList.map(u => {
                    if (u && (u.id === targetUserId || u.uid === targetUserId || (targetEmail && (u.email || u.username || '').toLowerCase() === targetEmail))) {
                        matchedUserEmail = (u.email || u.username || '').toLowerCase();
                        return {
                            ...u,
                            password: hashedPassword,
                            passwordHash: hashedPassword,
                            passwordUpdatedAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };
                    }
                    return u;
                });

                const updatedUserData = { users: usersList, updatedAt: new Date().toISOString() };
                await usersDocRef.set(updatedUserData);
                saveToLocalMirror(hotelId, 'config', 'users', updatedUserData);
                console.log(`[UPDATE_PASSWORD] Mot de passe mis à jour dans Firestore pour l'utilisateur ID: ${targetUserId}`);
            }

            // 4. Nettoyage multi-critères de la notification admin et des resets
            resets = resets.filter(r => r.token !== token);
            await resetDocRef.set({ resets, updatedAt: new Date().toISOString() });
            saveToLocalMirror(hotelId, 'config', 'passwordResets', { resets });

            const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordRequests');
            const reqDocSnap = await reqDocRef.get();
            
            if (reqDocSnap.exists) {
                let requests = reqDocSnap.data().requests || [];
                
                requests = requests.filter(r => {
                    if (!r) return false;
                    const rId = r.userId;
                    const rIdentifier = (r.identifier || '').toLowerCase();

                    const matchId = targetUserId && rId === targetUserId;
                    const matchEmail = (targetEmail && rIdentifier === targetEmail) || (matchedUserEmail && rIdentifier === matchedUserEmail);

                    return !(matchId || matchEmail);
                });
                
                const requestPayload = { requests, updatedAt: new Date().toISOString() };
                await reqDocRef.set(requestPayload);
                saveToLocalMirror(hotelId, 'config', 'passwordRequests', requestPayload);
                console.log(`[UPDATE_PASSWORD] Demandes de réinitialisation administratives nettoyées pour l'utilisateur.`);
            }

            return res.json({ success: true, message: "Mot de passe mis à jour avec succès et notification effacée." });

        } catch (err) {
            console.error(`[UPDATE_PASSWORD] Erreur serveur lors de la mise à jour du mot de passe :`, err);
            return res.status(500).json({ success: false, message: "Erreur serveur lors de la mise à jour." });
        }
    }

    console.warn(`[Public-Action] Action publique non reconnue : "${action}"`);
    return res.status(400).json({ success: false, message: "Action publique non reconnue." });
});

// ==========================================
// MIDDLEWARE SÉCURITÉ (SILENCIEUX CÔTÉ NAVIGATEUR - HTTP 200 + Miroir Local)
// ==========================================
async function verifierPermissionServeur(req, res, next) {
    const body = req.body || {};
    const query = req.query || {};

    const userIdentifier = body.username || body.userEmail || body.email || query.username || query.userEmail || query.email || query.identifier;
    const hotelId = body.hotelId || query.hotelId;
    const frontRole = body.userRole;
    const requiredRole = body.requiredRole;

    if (!userIdentifier || !hotelId) {
        return res.json({ 
            success: false, 
            code: 400,
            message: "Paramètres manquants : hotelId et username/email requis." 
        });
    }

    try {
        let configData = null;
        let usersList = [];

        try {
            const userDoc = await db.collection("hotels")
                                    .doc(hotelId)
                                    .collection("config")
                                    .doc("users")
                                    .get();
            
            if (userDoc.exists) {
                configData = userDoc.data();
                usersList = Array.isArray(configData.users) ? configData.users : [];
                // 🌟 Sauvegarde automatique dans le miroir local
                saveToLocalMirror(hotelId, 'config', 'users', configData);
            }
        } catch (cloudErr) {
            console.warn("⚠️ Cloud injoignable dans le middleware, lecture du miroir local RC-LOCALDATA...");
            const localData = readFromLocalMirror(hotelId, 'config', 'users');
            if (localData) {
                configData = localData;
                usersList = Array.isArray(localData.users) ? localData.users : [];
            }
        }

        if (!configData || usersList.length === 0) {
            return res.json({ success: false, code: 403, message: "Accès refusé." });
        }

        const cleanIdentifier = String(userIdentifier).trim().toLowerCase();

        const realUser = usersList.find(u => {
            const uName = (u.username || '').trim().toLowerCase();
            const uEmail = (u.email || '').trim().toLowerCase();
            return uName === cleanIdentifier || uEmail === cleanIdentifier;
        });

        if (!realUser) {
            return res.json({ success: false, code: 403, message: "Accès refusé." });
        }

        const rawRoleFromDb = realUser.role || realUser.roles || '';
        
        let realUserRolesList = [];
        if (typeof rawRoleFromDb === 'string') {
            realUserRolesList = rawRoleFromDb.split(',').map(r => r.trim().toLowerCase()).filter(r => r.length > 0);
        } else if (Array.isArray(rawRoleFromDb)) {
            realUserRolesList = rawRoleFromDb.map(r => String(r).trim().toLowerCase()).filter(r => r.length > 0);
        }

        const realUserRole = realUserRolesList.join(', ');

        if (frontRole) {
            const frontRolesList = String(frontRole).split(',').map(r => r.trim().toLowerCase()).filter(r => r.length > 0);
            const isFrontRoleValid = frontRolesList.every(fRole => realUserRolesList.includes(fRole));

            if (!isFrontRoleValid) {
                return res.json({ 
                    success: false, 
                    code: 403,
                    message: "Accès refusé." 
                });
            }
        }

        if (requiredRole) {
            const requiredArray = Array.isArray(requiredRole) 
                ? requiredRole.map(r => String(r).trim().toLowerCase()) 
                : [String(requiredRole).trim().toLowerCase()];

            let allowed = false;

            const hasCashier = realUserRolesList.includes('f&b cashier');
            const hasManager = realUserRolesList.includes('f&b manager');

            const isCashierRequired = requiredArray.some(r => r === 'f&b cashier');
            const isManagerRequired = requiredArray.some(r => r === 'f&b manager');

            if (isCashierRequired && isManagerRequired) {
                allowed = hasCashier || hasManager;
            } else if (isCashierRequired) {
                allowed = hasCashier;
            } else if (isManagerRequired) {
                allowed = hasManager;
            } else {
                allowed = requiredArray.some(reqR => realUserRolesList.includes(reqR));
            }

            if (!allowed) {
                return res.json({ 
                    success: false, 
                    code: 403,
                    message: "Accès refusé pour ce profil." 
                });
            }
        }

        req.userRole = realUserRole;
        req.targetHotelId = hotelId;
        req.currentUserData = realUser;
        next();

    } catch (error) {
        console.error("Erreur controle acces:", error);
        return res.json({ success: false, code: 500, message: "Une erreur est survenue." });
    }
}

// ==========================================
// GESTION CONFIGURATION DYNAMIQUE (Avec Miroir & Fallback)
// ==========================================
app.get('/api/admin/config/:configDoc', verifierPermissionServeur, async (req, res) => {
    const { configDoc } = req.params;
    const hotelId = req.targetHotelId || req.query.hotelId;

    if (!hotelId) {
        return res.status(400).json({ success: false, message: "ID hôtel manquant." });
    }

    try {
        const docSnap = await db.collection("hotels")
            .doc(hotelId)
            .collection("config")
            .doc(configDoc)
            .get();

        if (!docSnap.exists) {
            const localData = readFromLocalMirror(hotelId, 'config', configDoc);
            if (localData) return res.json({ success: true, ...localData });
            return res.json({ success: true, [configDoc]: [] });
        }

        const data = docSnap.data();
        saveToLocalMirror(hotelId, 'config', configDoc, data);
        return res.json({ success: true, ...data });
    } catch (err) {
        console.warn(`⚠️ Cloud injoignable pour config/${configDoc}, bascule sur le miroir local...`);
        const localData = readFromLocalMirror(hotelId, 'config', configDoc);
        if (localData) {
            return res.json({ success: true, ...localData, source: 'RC-LOCALDATA-OFFLINE' });
        }
        return res.status(500).json({ success: false, message: "Erreur lors de la récupération." });
    }
});

app.post('/api/admin/config/:configDoc', verifierPermissionServeur, async (req, res) => {
    const { configDoc } = req.params;
    const hotelId = req.targetHotelId || req.body.hotelId;

    if (!hotelId) {
        return res.status(400).json({ success: false, message: "ID hôtel manquant." });
    }

    try {
        const payload = {
            ...req.body,
            hotelId: hotelId,
            updatedAt: new Date().toISOString()
        };

        await db.collection("hotels")
            .doc(hotelId)
            .collection("config")
            .doc(configDoc)
            .set(payload, { merge: true });

        // 🌟 Synchro miroir local immédiate
        saveToLocalMirror(hotelId, 'config', configDoc, payload);

        return res.json({ success: true, message: `Configuration ${configDoc} sauvegardée.` });
    } catch (err) {
        console.error(`Erreur POST config/${configDoc}:`, err);
        return res.status(500).json({ success: false, message: "Erreur lors de la sauvegarde." });
    }
});

// ==========================================
// ROUTE EXPLICITE POUR LES DÉPARTEMENTS (Avec Miroir & Fallback)
// ==========================================
app.get('/api/admin/config/departement', verifierPermissionServeur, async (req, res) => {
    const hotelId = req.targetHotelId || req.query.hotelId;
    if (!hotelId) {
        return res.status(400).json({ success: false, message: "ID hôtel manquant." });
    }

    try {
        const docSnap = await db.collection("hotels")
            .doc(hotelId)
            .collection("config")
            .doc("departement")
            .get();

        if (!docSnap.exists) {
            const localData = readFromLocalMirror(hotelId, 'config', 'departement');
            if (localData) return res.json({ success: true, ...localData });
            return res.json({ success: true, departement: [] });
        }

        const data = docSnap.data();
        saveToLocalMirror(hotelId, 'config', 'departement', data);
        return res.json({ success: true, ...data });
    } catch (err) {
        const localData = readFromLocalMirror(hotelId, 'config', 'departement');
        if (localData) return res.json({ success: true, ...localData, source: 'RC-LOCALDATA-OFFLINE' });
        return res.status(500).json({ success: false, message: "Erreur lors de la récupération." });
    }
});

app.post('/api/admin/config/departement', verifierPermissionServeur, async (req, res) => {
    const hotelId = req.targetHotelId || req.body.hotelId;
    if (!hotelId) {
        return res.status(400).json({ success: false, message: "ID hôtel manquant." });
    }

    try {
        const payload = {
            ...req.body,
            hotelId: hotelId,
            updatedAt: new Date().toISOString()
        };

        await db.collection("hotels")
            .doc(hotelId)
            .collection("config")
            .doc("departement")
            .set(payload, { merge: true });

        saveToLocalMirror(hotelId, 'config', 'departement', payload);

        return res.json({ success: true, message: "Configuration départements sauvegardée." });
    } catch (err) {
        console.error("Erreur POST config/departement:", err);
        return res.status(500).json({ success: false, message: "Erreur lors de la sauvegarde." });
    }
});

// ==========================================
// ROUTE GÉNÉRIQUE EXÉCUTION ACTIONS DB (Avec Miroir & Fallback)
// ==========================================
app.post('/api/execute-db-action', verifierPermissionServeur, async (req, res) => {
    console.log("📥 Requête reçue sur /api/execute-db-action - Body complet :", req.body);

    const { action, collectionName, docId } = req.body;
    
    // Récupération ultra tolérante du payload (qu'il soit structuré dans dataPayload ou envoyé directement à plat)
    const dataPayload = req.body.dataPayload || (() => {
        const copy = { ...req.body };
        delete copy.action;
        delete copy.collectionName;
        delete copy.docId;
        delete copy.hotelId;
        return copy;
    })();

    const hotelId = req.targetHotelId || req.body.hotelId;

    if (action === 'GET_PASSWORD_REQUESTS') {
        try {
            if (!hotelId) {
                return res.json({ success: false, message: "ID de l'hôtel manquant." });
            }
            const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordRequests');
            const reqDocSnap = await reqDocRef.get();
            
            let requests = [];
            if (reqDocSnap.exists) {
                requests = reqDocSnap.data().requests || [];
                saveToLocalMirror(hotelId, 'config', 'passwordRequests', { requests });
            } else {
                const localData = readFromLocalMirror(hotelId, 'config', 'passwordRequests');
                if (localData && localData.requests) requests = localData.requests;
            }
            return res.json({ success: true, requests });
        } catch (err) {
            console.warn("⚠️ Cloud injoignable pour GET_PASSWORD_REQUESTS, lecture miroir local...");
            const localData = readFromLocalMirror(hotelId, 'config', 'passwordRequests');
            if (localData && localData.requests) {
                return res.json({ success: true, requests: localData.requests, source: 'RC-LOCALDATA-OFFLINE' });
            }
            return res.status(500).json({ success: false, message: "Erreur serveur" });
        }
    }

    if (action === 'GET_EXPORT_METADATA') {
        try {
            let hotelName = null;
            if (hotelId) {
                const hotelDoc = await db.collection('hotels').doc(hotelId).get();
                if (hotelDoc.exists) {
                    hotelName = hotelDoc.data().name || null;
                    saveToLocalMirror(hotelId, '_meta', 'info', hotelDoc.data());
                } else {
                    const localInfo = readFromLocalMirror(hotelId, '_meta', 'info');
                    if (localInfo) hotelName = localInfo.name || null;
                }
            }

            const rawUser = req.currentUserData || {};
            return res.json({
                success: true,
                data: {
                    hotelName,
                    fullName: rawUser.fullName || rawUser.displayName || rawUser.name || null,
                    email: rawUser.email || rawUser.username || null,
                    department: rawUser.department || null
                }
            });
        } catch (err) {
            console.error("Erreur GET_EXPORT_METADATA:", err);
            return res.status(500).json({ success: false, message: "Erreur récupération métadonnées." });
        }
    }

    if (collectionName === 'config' && docId === 'users' && action === 'UPDATE_SINGLE_USER') {
        try {
            const { userId, updateData } = dataPayload || {};
            
            const docRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
            const docSnap = await docRef.get();
            
            if (!docSnap.exists) {
                return res.json({ success: false, message: 'Document utilisateurs introuvable.' });
            }

            let users = docSnap.data().users || [];
            const userIndex = users.findIndex(u => u.id === userId);

            if (userIndex === -1) {
                return res.json({ success: false, message: 'Utilisateur introuvable dans la liste.' });
            }

            users[userIndex] = {
                ...users[userIndex],
                ...updateData,
                updatedAt: new Date().toISOString()
            };

            const payloadToSave = {
                hotelId,
                users: users,
                updatedAt: new Date().toISOString()
            };

            await docRef.set(payloadToSave);
            saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

            return res.json({ success: true, users: users });
        } catch (err) {
            console.error("Erreur UPDATE_SINGLE_USER:", err);
            return res.status(500).json({ success: false, message: "Erreur serveur lors de la mise à jour de l'utilisateur." });
        }
    }

    if (!action || !collectionName || !hotelId) {
        console.warn("⚠️ Paramètres manquants détectés :", { action, collectionName, hotelId });
        return res.status(400).json({ success: false, message: "Champs action, collectionName et hotelId requis." });
    }

    if ((action === 'UPDATE' || action === 'DELETE') && !docId) {
        return res.status(400).json({ success: false, message: "docId requis pour cette action." });
    }

    try {
        const collectionRef = db.collection("hotels").doc(hotelId).collection(collectionName);

        if (action === 'DELETE') {
            await collectionRef.doc(docId).delete();
            
            if (typeof deleteFromLocalMirror === 'function') {
                deleteFromLocalMirror(hotelId, collectionName, docId);
            } else {
                saveToLocalMirror(hotelId, collectionName, docId, { deleted: true, deletedAt: new Date().toISOString() });
            }

            return res.json({ success: true, message: "Suppression effectuée avec succès." });
        } 
        else if (action === 'UPDATE') {
            let finalPayload = dataPayload || {};

            // 🌟 SÉCURITÉ : Forcer isFirstLogin pour chaque utilisateur si on met à jour config/users
            if (collectionName === 'config' && docId === 'users' && finalPayload.users && Array.isArray(finalPayload.users)) {
                finalPayload.users = finalPayload.users.map(u => ({
                    ...u,
                    isFirstLogin: u.isFirstLogin !== undefined ? u.isFirstLogin : true
                }));
            }

            await collectionRef.doc(docId).set(finalPayload, { merge: true });
            
            saveToLocalMirror(hotelId, collectionName, docId, finalPayload);

            return res.json({ success: true, message: "Mise à jour effectuée avec succès." });
        }

        else if (action === 'SET') {
            const finalDocId = docId || `doc_${Date.now()}`;
            await collectionRef.doc(finalDocId).set(dataPayload || {}, { merge: true });
            
            saveToLocalMirror(hotelId, collectionName, finalDocId, dataPayload);

            return res.json({ success: true, message: "Enregistrement (SET) effectué avec succès.", docId: finalDocId });
        }
        else if (action === 'GET') {
            if (docId) {
                const docSnap = await collectionRef.doc(docId).get();
                if (!docSnap.exists) {
                    return res.json({ success: true, data: null });
                }
                const docData = { id: docSnap.id, ...docSnap.data() };
                saveToLocalMirror(hotelId, collectionName, docId, docData);
                return res.json({ success: true, data: docData });
            } else {
                const snapshot = await collectionRef.get();
                const documents = {};
                snapshot.forEach(doc => {
                    documents[doc.id] = doc.data();
                });
                saveToLocalMirror(hotelId, collectionName, '_all', documents);
                return res.json({ success: true, data: documents });
            }
        }
        else if (action === 'CREATE') {
            const finalDocId = docId || `doc_${Date.now()}`;
            await collectionRef.doc(finalDocId).set(dataPayload || {});
            
            saveToLocalMirror(hotelId, collectionName, finalDocId, dataPayload);

            return res.json({ success: true, message: "Création effectuée avec succès.", docId: finalDocId });
        }

        return res.status(400).json({ success: false, message: "Action non reconnue." });
    } catch (err) {
        console.error("Erreur execute-db-action:", err);
        return res.status(500).json({ success: false, message: "Erreur serveur lors de l'opération." });
    }
});
// Récupérer les informations d'un hôtel par son ID
app.get('/api/hotels/:id', async (req, res) => {
    try {
        const doc = await db.collection('hotels').doc(req.params.id).get();
        if (!doc.exists) {
            return res.status(404).json({ message: "Hôtel introuvable" });
        }
        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// MISE À JOUR DU PREMIER MOT DE PASSE (Compatible config/users)
// ==========================================
app.post('/api/admin/users/update-first-login-password', async (req, res) => {
    try {
        const { hotelId, userId, oldPassword, newPassword } = req.body;

        if (!hotelId || !userId || !oldPassword || !newPassword) {
            return res.status(400).json({ success: false, message: "Données manquantes." });
        }

        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: "Dossier utilisateurs introuvable." });
        }

        let users = docSnap.data().users || [];
        const index = users.findIndex(u => u.id === userId);

        if (index === -1) {
            return res.status(404).json({ success: false, message: "Utilisateur introuvable." });
        }

        const targetUser = users[index];
        const pwdToCompare = targetUser.password || targetUser.passwordHash || '';

        // 🛡️ Vérification sécurisée de l'ancien mot de passe via bcrypt
        let isOldPasswordValid = false;
        if (typeof bcrypt !== 'undefined' && bcrypt.compareSync) {
            isOldPasswordValid = bcrypt.compareSync(oldPassword, pwdToCompare);
        } else {
            isOldPasswordValid = (oldPassword === pwdToCompare);
        }

        if (!isOldPasswordValid) {
            return res.status(400).json({ success: false, message: "L'ancien mot de passe est incorrect." });
        }

        // 🛑 Empêcher l'utilisateur de remettre exactement le même mot de passe
        if (oldPassword === newPassword.trim()) {
            return res.status(400).json({ success: false, message: "Le nouveau mot de passe doit être différent de l'ancien." });
        }

        // Hachage sécurisé du nouveau mot de passe
        const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

        users[index] = {
            ...users[index],
            password: hashedPassword,
            passwordHash: hashedPassword,
            isFirstLogin: false,
            passwordUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await configDocRef.update({ users, updatedAt: new Date().toISOString() });

        return res.json({ success: true, message: "Mot de passe mis à jour avec succès." });

    } catch (error) {
        // 🔒 Log neutre pour ne laisser aucune trace exploitable par un hacker
        console.error("Erreur de sécurité lors du traitement du mot de passe.");
        return res.status(500).json({ success: false, message: "Erreur serveur interne." });
    }
});
// Route Express pour récupérer les réservations d'un hôtel de manière sécurisée
app.get('/api/hotels/:hotelId/bookings', async (req, res) => {
    try {
        const { hotelId } = req.params;
        const userId = req.headers['x-user-id'];

        // Optionnel : Vérification de sécurité avec le userId si nécessaire
        if (!userId) {
            return res.status(401).json({ error: "Utilisateur non authentifié." });
        }

        // Récupération dynamique depuis la sous-collection Firestore
        const bookingsRef = db.collection('hotels').doc(hotelId).collection('bookings');
        const snapshot = await bookingsRef.get();

        const bookings = [];
        const batch = db.batch(); // Permet de grouper les modifications Firestore pour optimiser
        let hasChanges = false;
        const now = new Date(); // Heure actuelle du serveur

        snapshot.forEach(doc => {
            const data = doc.data();
            let currentStatus = data.status || 'RÉSERVÉE';
            let calculatedStatus = currentStatus;

            // On s'assure d'avoir les dates de check-in et check-out valides
            const checkIn = data.checkIn ? new Date(data.checkIn) : null;
            const checkOut = data.checkOut ? new Date(data.checkOut) : null;

            if (checkIn && checkOut && !isNaN(checkIn) && !isNaN(checkOut)) {
                // Logique intelligente d'évolution du statut en fonction du temps
                if (now > checkOut) {
                    calculatedStatus = 'TERMINÉE';
                } else if (now >= checkIn && now <= checkOut) {
                    calculatedStatus = 'OCCUPÉE';
                } else if (now < checkIn) {
                    // Si on est avant la date de check-in, on garde 'RÉSERVÉE' 
                    // (sauf si un autre statut manuel spécifique existe)
                    if (currentStatus !== 'ANNULÉE') {
                        calculatedStatus = 'RÉSERVÉE';
                    }
                }

                // Si le statut calculé diffère de celui enregistré dans Firestore, on met à jour
                if (calculatedStatus !== currentStatus) {
                    hasChanges = true;
                    batch.update(doc.ref, { status: calculatedStatus });
                    data.status = calculatedStatus; // Met à jour l'objet renvoyé immédiatement
                }
            }

            bookings.push({
                id: doc.id,
                ...data
            });
        });

        // Si des statuts ont évolué avec le temps, on valide les modifications dans Firestore
        if (hasChanges) {
            await batch.commit();
        }

        res.status(200).json(bookings);
    } catch (error) {
        console.error("Erreur serveur lors de la récupération des bookings:", error);
        res.status(500).json({ error: "Erreur interne du serveur." });
    }
});

app.post('/api/verify-session', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.json({ valid: false, message: "Token manquant." });
        }

        // On parcourt les hôtels pour trouver l'utilisateur qui possède ce sessionToken
        const hotelsSnapshot = await db.collection('hotels').get();
        let matchedUser = null;
        let matchedHotelId = null;

        for (const hotelDoc of hotelsSnapshot.docs) {
            const userDoc = await db.collection('hotels')
                .doc(hotelDoc.id)
                .collection('config')
                .doc('users')
                .get();

            if (userDoc.exists) {
                const data = userDoc.data();
                const usersArray = data.users || [];
                const found = usersArray.find(u => u.sessionToken === token);
                if (found) {
                    matchedUser = found;
                    matchedHotelId = hotelDoc.id;
                    break;
                }
            }
        }

        if (!matchedUser) {
            return res.json({ valid: false, message: "Session introuvable ou expirée." });
        }

        return res.json({ 
            valid: true, 
            role: matchedUser.role,
            user: matchedUser 
        });
    } catch (error) {
        console.error("Erreur verify-session:", error);
        return res.status(500).json({ valid: false, error: error.message });
    }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur API Room Check démarré sur le port ${PORT}`);
});