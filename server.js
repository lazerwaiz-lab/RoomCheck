process.env.TZ = 'Africa/Porto-Novo';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs'); // <--- 1. Ajoute fs ici
const path = require('path');
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
    'https://roomcheck-a24u.onrender.com'
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
            email: cleanEmail,
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
// 2. ROUTE UNIQUE DE LOGIN (Avec Miroir Local)
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

        for (const hotelDoc of hotelsSnapshot.docs) {
            const hotelId = hotelDoc.id;
            const hotelData = hotelDoc.data();
            
            const configUserDoc = await hotelDoc.ref.collection('config').doc('users').get();
            if (configUserDoc.exists) {
                const configData = configUserDoc.data();
                
                // 🌟 Sauvegarde automatique dans le miroir local à chaque lecture cloud réussie
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
                        break;
                    }
                }
            }
        }

        // --- MODE SECOURS LOCAL SI CLOUD INJOIGNABLE ---
        if (!foundUser) {
            console.warn("⚠️ Cloud injoignable ou utilisateur introuvable, tentative de connexion via le miroir RC-LOCALDATA...");
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

        const storedPassword = foundUser.passwordHash || foundUser.password || '';
        let isPasswordCorrect = false;

        if (storedPassword.startsWith('$2')) {
            isPasswordCorrect = await bcrypt.compare(password.trim(), storedPassword);
        } else {
            isPasswordCorrect = (password.trim() === storedPassword);
        }

        if (!isPasswordCorrect) {
            return res.status(401).json({ success: false, message: 'Identifiant ou mot de passe incorrect.' });
        }

        delete foundUser.passwordHash;
        delete foundUser.password;

        return res.json({
            success: true,
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
        const { hotelId, fullName, username, password, department, role, createdBy, isCreator } = req.body;

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
        if (currentUsers.some(u => (u.username || '').toLowerCase() === cleanUsername)) {
            return res.status(409).json({ success: false, message: 'Nom d\'utilisateur déjà pris.' });
        }

        const hashedPassword = await bcrypt.hash(password.trim(), 10);
        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

        const newUser = {
            id: userId,
            fullName: fullName ? fullName.trim() : 'Utilisateur',
            username: cleanUsername,
            email: cleanUsername.includes('@') ? cleanUsername : `${cleanUsername}@hotel.com`,
            password: hashedPassword,
            passwordHash: hashedPassword,
            department: department || 'IT',
            role: role || 'user',
            isCreator: !!isCreator,
            colorMark: isCreator ? 'red' : 'default',
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
    const { hotelId, targetUserId, newPassword, requesterId } = req.body;

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

        const requester = users.find(u => u.id === requesterId || u.username === requesterId);
        
        // 🛡️ Vérification robuste du rôle Superadmin (gère les chaînes avec virgules et les tableaux)
        const rawRole = requester ? (requester.role || requester.roles || '') : '';
        const rolesArray = typeof rawRole === 'string' 
            ? rawRole.split(',').map(r => r.trim().toLowerCase()) 
            : Array.isArray(rawRole) ? rawRole.map(r => String(r).trim().toLowerCase()) : [];
        
        const isRequesterSuperAdmin = rolesArray.includes('superadmin');

        if (!requester || !isRequesterSuperAdmin) {
            return res.json({ 
                success: false, 
                message: "Vous n'êtes pas autorisé à modifier les mots de passe." 
            });
        }

        const index = users.findIndex(u => u.id === targetUserId);
        if (index === -1) {
            return res.json({ success: false, message: 'Utilisateur introuvable.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

        users[index].password = hashedPassword;
        users[index].passwordHash = hashedPassword;
        users[index].isFirstLogin = true; 
        users[index].updatedAt = new Date().toISOString();

        const payloadToSave = { hotelId, users, updatedAt: new Date().toISOString() };
        await configDocRef.update(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        // 🧹 SUPPRESSION DE LA NOTIFICATION ASSOCIÉE
        const reqDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('passwordRequests');
        const reqDocSnap = await reqDocRef.get();
        if (reqDocSnap.exists) {
            let requests = reqDocSnap.data().requests || [];
            requests = requests.filter(r => r.userId !== targetUserId);
            const reqPayload = { requests, updatedAt: new Date().toISOString() };
            await reqDocRef.set(reqPayload);
            saveToLocalMirror(hotelId, 'config', 'passwordRequests', reqPayload);
        }

        return res.json({ success: true, message: 'Mot de passe réinitialisé avec succès !' });
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
            return res.status(400).json({ error: 'Données invalides ou liste utilisateurs absente.' });
        }

        const docRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await docRef.get();
        const existingUsers = docSnap.exists ? (docSnap.data().users || []) : [];

        const creators = existingUsers.filter(u => u.isCreator === true || u.isCreator === 'true');

        const processedUsers = await Promise.all(users.map(async (user, index) => {
            const rawPassword = user.password || user.pass || '123456';

            let hashedPassword = rawPassword;
            if (!rawPassword.startsWith('$2a$') && !rawPassword.startsWith('$2b$') && !rawPassword.startsWith('$2y$')) {
                hashedPassword = await bcrypt.hash(rawPassword.trim(), 10);
            }

            return {
                ...user,
                id: user.id || ('usr_' + Date.now() + '_' + index + '_' + Math.random().toString(36).substr(2, 4)),
                password: hashedPassword,
                passwordHash: hashedPassword,
                createdBy: user.createdBy || createdBy || 'Superadmin',
                createdAt: user.createdAt || new Date().toISOString()
            };
        }));

        const filteredImported = processedUsers.filter(pUser => 
            !creators.some(c => (c.email && pUser.email && c.email.toLowerCase() === pUser.email.toLowerCase()) || c.id === pUser.id)
        );

        const finalUsers = [...creators, ...filteredImported];

        const payloadToSave = {
            hotelId,
            users: finalUsers,
            updatedAt: new Date().toISOString()
        };

        await docRef.set(payloadToSave);
        saveToLocalMirror(hotelId, 'config', 'users', payloadToSave);

        res.json({ message: 'Importation enregistrée sans impacter le créateur', users: finalUsers });
    } catch (error) {
        console.error("Erreur import users:", error);
        res.status(500).json({ error: error.message });
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

// --- ROUTE PUBLIQUE (Avec secours hors-ligne RC-LOCALDATA) ---
app.post('/api/public-action', async (req, res) => {
    const { action, dataPayload } = req.body;

    // Action : Récupération du nom de l'utilisateur
    if (action === 'GET_USER_NAME') {
        try {
            const identifier = dataPayload?.identifier?.trim().toLowerCase();
            const hotelsSnapshot = await db.collection('hotels').get();
            let foundFullName = null;

            for (const hotelDoc of hotelsSnapshot.docs) {
                const hotelId = hotelDoc.id;
                const userDocSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('users').get();
                
                let usersList = [];
                if (userDocSnap.exists) {
                    const data = userDocSnap.data();
                    usersList = Array.isArray(data.users) ? data.users : Object.values(data);
                    saveToLocalMirror(hotelId, 'config', 'users', data);
                } else {
                    // Secours miroir local
                    const localData = readFromLocalMirror(hotelId, 'config', 'users');
                    if (localData && Array.isArray(localData.users)) {
                        usersList = localData.users;
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
                    break;
                }
            }

            if (foundFullName) {
                return res.json({ success: true, fullName: foundFullName });
            } else {
                return res.json({ success: false, message: "Utilisateur non trouvé" });
            }
        } catch (err) {
            console.warn("⚠️ Cloud injoignable pour GET_USER_NAME, recherche dans les miroirs locaux...");
            
            // 🌟 Recherche par répertoires locaux si Firestore échoue totalement
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
                            break;
                        }
                    }
                }
            }

            if (foundFullName) {
                return res.json({ success: true, fullName: foundFullName, source: 'RC-LOCALDATA-OFFLINE' });
            }

            return res.status(500).json({ success: false, message: "Erreur serveur et données locales introuvables" });
        }
    }

    // Action : Demande de réinitialisation de mot de passe
    if (action === 'REQUEST_PASSWORD_RESET') {
        try {
            const identifier = dataPayload?.identifier?.trim().toLowerCase();
            if (!identifier) {
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
                    break;
                }
            }

            if (!matchedUser || !targetHotelId) {
                return res.json({ success: true, message: "Demande prise en compte." });
            }

            const reqDocRef = db.collection('hotels').doc(targetHotelId).collection('config').doc('passwordRequests');
            const reqDocSnap = await reqDocRef.get();
            let requests = reqDocSnap.exists ? (reqDocSnap.data().requests || []) : [];

            const existingIndex = requests.findIndex(r => r.userId === matchedUser.id);
            if (existingIndex === -1) {
                requests.push({
                    userId: matchedUser.id,
                    fullName: matchedUser.fullName || `${matchedUser.prenom || ''} ${matchedUser.nom || ''}`.trim(),
                    identifier: matchedUser.username || matchedUser.email,
                    createdAt: new Date().toISOString()
                });
                const reqPayload = { requests, updatedAt: new Date().toISOString() };
                await reqDocRef.set(reqPayload);
                saveToLocalMirror(targetHotelId, 'config', 'passwordRequests', reqPayload);
            }

            return res.json({ success: true, message: "Demande envoyée à l'administration." });
        } catch (err) {
            console.error("Erreur REQUEST_PASSWORD_RESET:", err);
            return res.status(500).json({ success: false, message: "Erreur serveur" });
        }
    }

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

            const allowed = requiredArray.some(reqR => realUserRolesList.includes(reqR));

            if (!allowed) {
                return res.json({ 
                    success: false, 
                    code: 403,
                    message: "Accès refusé." 
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
            
            // Miroir local : Sauvegarde de la suppression (ou suppression du fichier miroir associé)
            if (typeof deleteFromLocalMirror === 'function') {
                deleteFromLocalMirror(hotelId, collectionName, docId);
            } else {
                saveToLocalMirror(hotelId, collectionName, docId, { deleted: true, deletedAt: new Date().toISOString() });
            }

            return res.json({ success: true, message: "Suppression effectuée avec succès." });
        } 
        else if (action === 'UPDATE') {
            await collectionRef.doc(docId).set(dataPayload || {}, { merge: true });
            
            // Miroir local : Sauvegarde de la mise à jour
            saveToLocalMirror(hotelId, collectionName, docId, dataPayload);

            return res.json({ success: true, message: "Mise à jour effectuée avec succès." });
        }
        else if (action === 'CREATE') {
            const finalDocId = docId || `doc_${Date.now()}`;
            await collectionRef.doc(finalDocId).set(dataPayload || {});
            
            // Miroir local : Sauvegarde de la création
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur API Room Check démarré sur le port ${PORT}`);
});