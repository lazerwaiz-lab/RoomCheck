const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'], // <-- AJOUTE 'x-user-id' ICI !
    credentials: true
}));

// 2. Limite des requêtes JSON (2 Mo)
app.use(express.json({ limit: '2mb' }));

// 3. Sert tous les fichiers HTML/JS/CSS à la racine de room-checker-service
//app.use(express.static(__dirname));

// 4. Route d'accueil
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

        // VÉRIFICATION EXISTENCE NOM D'HÔTEL
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

        // VÉRIFICATION UNICITÉ GLOBALE DE L'EMAIL ADMIN DANS CONFIG/USERS
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

        // CRÉATION DE L'HÔTEL
        const hotelRef = await db.collection('hotels').add({
            name: cleanName,
            createdAt: new Date().toISOString()
        });

        const hotelId = hotelRef.id;

        // CRÉATION DU COMPTE CRÉATEUR / MASTER ADMIN DANS CONFIG/USERS
const salt = await bcrypt.genSalt(10);
const hashedPassword = await bcrypt.hash(password.trim(), salt); // Un seul hash propre
const adminId = 'usr_' + Date.now() + '_creator';

const creatorAdminUser = {
    id: adminId,
    fullName: adminName.trim(),
    username: cleanEmail,
    email: cleanEmail,
    password: hashedPassword,     // <-- On met le hash ici aussi
    passwordHash: hashedPassword, // <-- Et ici aussi
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
// 2. ROUTE UNIQUE DE LOGIN
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
            const configUserDoc = await hotelDoc.ref.collection('config').doc('users').get();
            if (configUserDoc.exists) {
                const configData = configUserDoc.data();
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
                        foundHotel = { id: hotelDoc.id, ...hotelDoc.data() };
                        break;
                    }
                }
            }

            const usersRef = hotelDoc.ref.collection('users');
            let userSnapshot = await usersRef.where('email', '==', identifier).get();
            if (userSnapshot.empty) {
                userSnapshot = await usersRef.where('username', '==', identifier).get();
            }

            if (!userSnapshot.empty) {
                const userDoc = userSnapshot.docs[0];
                const userData = userDoc.data();
                foundUser = { 
                    id: userDoc.id || userData.id || ('usr_' + Date.now()), 
                    ...userData 
                };
                foundHotel = { id: hotelDoc.id, ...hotelDoc.data() };
                break;
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
            mustChangePassword: foundUser.isFirstLogin === true, // <-- Ajoute cette ligne explicite
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
// 3. GESTION DES UTILISATEURS DANS CONFIG/USERS
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
        const usersList = (configData.users || []).map(u => {
            const copy = { ...u };
            delete copy.password;
            delete copy.passwordHash;
            return copy;
        });

        return res.json({ success: true, users: usersList });
    } catch (error) {
        console.error('Erreur chargement utilisateurs:', error);
        return res.status(500).json({ success: false, message: 'Erreur serveur.' });
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

        await configDocRef.set({
            hotelId: hotelId,
            users: currentUsers,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        const safeUser = { ...newUser };
        delete safeUser.password;
        delete safeUser.passwordHash;

        return res.status(201).json({ success: true, message: 'Utilisateur créé avec succès dans config/users !', user: safeUser });
    } catch (error) {
        console.error('Erreur création utilisateur:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

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

        await configDocRef.update({ users, updatedAt: new Date().toISOString() });
        return res.json({ success: true, message: 'Utilisateur mis à jour avec succès !' });
    } catch (error) {
        console.error('Erreur mise à jour utilisateur:', error);
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

        // VÉRIFICATION STRICTE DU RÔLE EN BASE DE DONNÉES
        const requester = users.find(u => u.id === requesterId || u.username === requesterId);
        if (!requester || (requester.role || '').toLowerCase() !== 'superadmin') {
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
        users[index].isFirstLogin = true; // <--- AJOUTE CETTE LIGNE ICI POUR FORCER LE CHANGEMENT AU PROCHAIN LOGIN
        users[index].updatedAt = new Date().toISOString();

        await configDocRef.update({ users, updatedAt: new Date().toISOString() });
        return res.json({ success: true, message: 'Mot de passe réinitialisé avec succès !' });
    } catch (error) {
        return res.json({ success: false, message: 'Une erreur serveur est survenue.' });
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

        await configDocRef.update({ users: updatedUsers, updatedAt: new Date().toISOString() });
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

        // 1. Récupération du document existant pour sécuriser le créateur
        const docRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await docRef.get();
        const existingUsers = docSnap.exists ? (docSnap.data().users || []) : [];

        // Isoler le(s) créateur(s) du compte
        const creators = existingUsers.filter(u => u.isCreator === true || u.isCreator === 'true');

        // 2. Traitement et hachage des nouveaux utilisateurs importés
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

        // 3. Filtrer les doublons de l'import pour ne pas dupliquer le créateur
        const filteredImported = processedUsers.filter(pUser => 
            !creators.some(c => (c.email && pUser.email && c.email.toLowerCase() === pUser.email.toLowerCase()) || c.id === pUser.id)
        );

        // 4. Fusionner : Le créateur reste intact au début du tableau
        const finalUsers = [...creators, ...filteredImported];

        await docRef.set({
            hotelId,
            users: finalUsers,
            updatedAt: new Date().toISOString()
        });

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

        // On met à jour uniquement les champs envoyés, en conservant son mot de passe et ses données d'origine intactes
        users[userIndex] = {
            ...users[userIndex],
            ...updateData,
            updatedAt: new Date().toISOString()
        };

        await docRef.set({
            hotelId,
            users: users,
            updatedAt: new Date().toISOString()
        });

        res.json({ message: 'Utilisateur mis à jour avec succès', users: users });
    } catch (error) {
        console.error("Erreur mise à jour utilisateur unique:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. AUTRES CONFIGURATIONS
// ==========================================
app.get('/api/admin/config/roles', async (req, res) => {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const docSnap = await db.collection('hotels').doc(hotelId).collection('config').doc('roles').get();
        if (!docSnap.exists) return res.json({ success: true, roles: [] });
        return res.json({ success: true, ...docSnap.data() });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config/roles', async (req, res) => {
    const { hotelId, roles } = req.body;
    if (!hotelId || !Array.isArray(roles)) return res.status(400).json({ success: false, message: 'Données invalides.' });

    try {
        await db.collection('hotels').doc(hotelId).collection('config').doc('roles').set({
            roles: roles,
            updatedAt: new Date().toISOString()
        });
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
        if (!docSnap.exists) return res.json({ success: true, floors: {} });
        return res.json({ success: true, ...docSnap.data() });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config/structure', async (req, res) => {
    const { hotelId, floors } = req.body;
    if (!hotelId || !floors) return res.status(400).json({ success: false, message: 'Données invalides.' });

    try {
        await db.collection('hotels').doc(hotelId).collection('config').doc('structure').set({
            hotelId: hotelId,
            floors: floors,
            updatedAt: new Date().toISOString()
        });
        return res.json({ success: true, message: 'Structure enregistrée avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. GESTION DES TICKETS
// ==========================================
app.get('/api/tickets', async (req, res) => {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const snapshot = await db.collection('hotels').doc(hotelId).collection('tickets').get();
        const tickets = [];
        snapshot.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
        return res.json({ success: true, tickets });
    } catch (error) {
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
        return res.json({ success: true, id: docRef.id, ticket: { id: docRef.id, ...newTicket }, message: 'Ticket créé avec succès !' });
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
        return res.json({ success: true, message: 'Ticket supprimé avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================================
// MIDDLEWARE SÉCURITÉ (SILENCIEUX CÔTÉ NAVIGATEUR - HTTP 200)
// ==========================================================
async function verifierPermissionServeur(req, res, next) {
    const body = req.body || {};
    const query = req.query || {};

    // 1. Détection flexible de l'identifiant
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
        // 2. Récupération des utilisateurs réels dans Firestore
        const userDoc = await db.collection("hotels")
                                .doc(hotelId)
                                .collection("config")
                                .doc("users")
                                .get();
        
        if (!userDoc.exists) {
            return res.json({ success: false, code: 403, message: "Accès refusé." });
        }

        const configData = userDoc.data();
        const usersList = Array.isArray(configData.users) ? configData.users : [];
        const cleanIdentifier = String(userIdentifier).trim().toLowerCase();

        // 3. Identification du User dans Firestore via username ou email
        const realUser = usersList.find(u => {
            const uName = (u.username || '').trim().toLowerCase();
            const uEmail = (u.email || '').trim().toLowerCase();
            return uName === cleanIdentifier || uEmail === cleanIdentifier;
        });

        if (!realUser) {
            return res.json({ success: false, code: 403, message: "Accès refusé." });
        }

        // --- GESTION MULTI-RÔLES EN BDD ---
        // On récupère le champ 'role' (qui peut être "Housekeeping, Reception") ou un tableau 'roles'
        const rawRoleFromDb = realUser.role || realUser.roles || '';
        
        // On transforme systématiquement en un tableau propre de rôles en minuscules
        let realUserRolesList = [];
        if (typeof rawRoleFromDb === 'string') {
            realUserRolesList = rawRoleFromDb.split(',').map(r => r.trim().toLowerCase()).filter(r => r.length > 0);
        } else if (Array.isArray(rawRoleFromDb)) {
            realUserRolesList = rawRoleFromDb.map(r => String(r).trim().toLowerCase()).filter(r => r.length > 0);
        }

        // Pour compatibilité si le reste du code a besoin d'une chaîne principale
        const realUserRole = realUserRolesList.join(', ');

        // 4. CONTRÔLE SÉCURITÉ ANTI-ALTÉRATION (Support multi-rôles front)
        if (frontRole) {
            // On découpe aussi le rôle envoyé par le front au cas où il contiendrait des virgules
            const frontRolesList = String(frontRole).split(',').map(r => r.trim().toLowerCase()).filter(r => r.length > 0);
            
            // On vérifie que tous les rôles revendiqués par le front font bien partie des rôles réels de l'utilisateur en BDD
            const isFrontRoleValid = frontRolesList.every(fRole => realUserRolesList.includes(fRole));

            if (!isFrontRoleValid) {
                return res.json({ 
                    success: false, 
                    code: 403,
                    message: "Accès refusé." 
                });
            }
        }

        // 5. VÉRIFICATION DYNAMIQUE DE PRIVILÈGES (Multi-rôles supporté)
        if (requiredRole) {
            // Le rôle requis peut être un tableau ou une chaîne unique
            const requiredArray = Array.isArray(requiredRole) 
                ? requiredRole.map(r => String(r).trim().toLowerCase()) 
                : [String(requiredRole).trim().toLowerCase()];

            // On regarde si l'utilisateur possède AU MOINS l'un des rôles requis
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
// GESTION CONFIGURATION DYNAMIQUE
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
            return res.json({ success: true, [configDoc]: [] });
        }

        return res.json({ success: true, ...docSnap.data() });
    } catch (err) {
        console.error(`Erreur GET config/${configDoc}:`, err);
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

        return res.json({ success: true, message: `Configuration ${configDoc} sauvegardée.` });
    } catch (err) {
        console.error(`Erreur POST config/${configDoc}:`, err);
        return res.status(500).json({ success: false, message: "Erreur lors de la sauvegarde." });
    }
});
// ==========================================
// ROUTE EXPLICITE POUR LES DÉPARTEMENTS
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
            .doc("departement") // Assure-toi que le nom du doc correspond dans Firestore
            .get();

        if (!docSnap.exists) {
            return res.json({ success: true, departement: [] });
        }

        return res.json({ success: true, ...docSnap.data() });
    } catch (err) {
        console.error("Erreur GET config/departement:", err);
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

        return res.json({ success: true, message: "Configuration départements sauvegardée." });
    } catch (err) {
        console.error("Erreur POST config/departement:", err);
        return res.status(500).json({ success: false, message: "Erreur lors de la sauvegarde." });
    }
});

// ==========================================
// ROUTE GÉNÉRIQUE EXÉCUTION ACTIONS DB
// ==========================================
app.post('/api/execute-db-action', verifierPermissionServeur, async (req, res) => {
    const { action, collectionName, docId, dataPayload } = req.body;
    const hotelId = req.targetHotelId || req.body.hotelId;

    // Action personnalisée : Récupération des métadonnées pour export PDF/Excel
    if (action === 'GET_EXPORT_METADATA') {
        try {
            let hotelName = null;
            if (hotelId) {
                const hotelDoc = await db.collection('hotels').doc(hotelId).get();
                if (hotelDoc.exists) {
                    hotelName = hotelDoc.data().name || null;
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

    // Action personnalisée : Mise à jour d'un seul utilisateur sans impacter son mot de passe
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

            // On fusionne les nouvelles modifications tout en préservant son mot de passe existant
            users[userIndex] = {
                ...users[userIndex],
                ...updateData,
                updatedAt: new Date().toISOString()
            };

            await docRef.set({
                hotelId,
                users: users,
                updatedAt: new Date().toISOString()
            });

            return res.json({ success: true, users: users });
        } catch (err) {
            console.error("Erreur UPDATE_SINGLE_USER:", err);
            return res.status(500).json({ success: false, message: "Erreur serveur lors de la mise à jour de l'utilisateur." });
        }
    }

    // On retire docId des vérifications obligatoires initiales
    if (!action || !collectionName || !hotelId) {
        return res.status(400).json({ success: false, message: "Champs action, collectionName et hotelId requis." });
    }

    // Le docId reste obligatoire uniquement pour UPDATE et DELETE
    if ((action === 'UPDATE' || action === 'DELETE') && !docId) {
        return res.status(400).json({ success: false, message: "docId requis pour cette action." });
    }

    try {
        const collectionRef = db.collection("hotels").doc(hotelId).collection(collectionName);

        if (action === 'DELETE') {
            await collectionRef.doc(docId).delete();
            return res.json({ success: true, message: "Suppression effectuée avec succès." });
        } 
        else if (action === 'UPDATE') {
            await collectionRef.doc(docId).set(dataPayload || {}, { merge: true });
            return res.json({ success: true, message: "Mise à jour effectuée avec succès." });
        }
        else if (action === 'CREATE') {
            // Génération d'un ID personnalisé basé sur la date et l'heure précise
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-');
            const customDocId = `ticket_${timestamp}`;

            // On enregistre le document avec ton ID personnalisé
            await collectionRef.doc(customDocId).set(dataPayload || {});
            return res.json({ success: true, message: "Création effectuée avec succès.", docId: customDocId });
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
        const { hotelId, userId, newPassword } = req.body;

        if (!hotelId || !userId || !newPassword) {
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

        // Hachage du nouveau mot de passe avec bcrypt pour la sécurité
        const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

        users[index] = {
            ...users[index],
            password: hashedPassword,
            passwordHash: hashedPassword,
            isFirstLogin: false, // On désactive le blocage
            updatedAt: new Date().toISOString()
        };

        await configDocRef.update({ users, updatedAt: new Date().toISOString() });

        return res.json({ success: true, message: "Mot de passe mis à jour avec succès." });

    } catch (error) {
        console.error("Erreur lors de la mise à jour du premier mot de passe:", error);
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