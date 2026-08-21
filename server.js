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
    'https://roomcheck.centillion.online'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Accès bloqué par la politique CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// 2. Limite des requêtes JSON (2 Mo)
app.use(express.json({ limit: '2mb' }));

// 3. Sert tous les fichiers HTML/JS/CSS à la racine de room-checker-service
app.use(express.static(__dirname));

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
        const passwordHash = await bcrypt.hash(password.trim(), salt);
        const adminId = 'usr_' + Date.now() + '_creator';

        const creatorAdminUser = {
            id: adminId,
            fullName: adminName.trim(),
            username: cleanEmail,
            email: cleanEmail,
            password: passwordHash,
            passwordHash: passwordHash,
            department: 'ADMIN',
            role: 'superadmin',
            isCreator: true, // Marquage spécifique pour identification
            colorMark: 'red', // Indicateur de couleur pour les logs/outils
            createdBy: 'SYSTEM_REGISTER',
            createdAt: new Date().toISOString()
        };

        // Sauvegarde directement dans config/users
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
// 2. ROUTE UNIQUE DE LOGIN (CONFIG/USERS ET FALLBACK SOUS-COLLECTION)
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
            // A. RECHERCHE PRINCIPALE DANS /config/users
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

            // B. FALLBACK DE COMPATIBILITÉ : ANCIENNE SOUS-COLLECTION /users
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

// RÉCUPÉRATION DE TOUS LES UTILISATEURS DE CONFIG/USERS
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

// CRÉATION D'UN NOUVEL UTILISATEUR DANS CONFIG/USERS
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

// MODIFICATION D'UN UTILISATEUR DANS CONFIG/USERS
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

// RÉINITIALISATION DE MOT DE PASSE DANS CONFIG/USERS
app.post('/api/admin/users/reset-password', async (req, res) => {
    const { hotelId, targetUserId, newPassword } = req.body;

    if (!hotelId || !targetUserId || !newPassword || newPassword.trim() === '') {
        return res.status(400).json({ success: false, message: 'Paramètres manquants pour la réinitialisation.' });
    }

    try {
        const configDocRef = db.collection('hotels').doc(hotelId).collection('config').doc('users');
        const docSnap = await configDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'Dossier utilisateurs introuvable.' });
        }

        let users = docSnap.data().users || [];
        const index = users.findIndex(u => u.id === targetUserId);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

        users[index].password = hashedPassword;
        users[index].passwordHash = hashedPassword;
        users[index].updatedAt = new Date().toISOString();

        await configDocRef.update({ users, updatedAt: new Date().toISOString() });
        return res.json({ success: true, message: 'Mot de passe réinitialisé avec succès !' });
    } catch (error) {
        console.error('Erreur réinitialisation mot de passe:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// SUPPRESSION D'UN UTILISATEUR DANS CONFIG/USERS
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

// IMPORTATION DE MASSE DANS CONFIG/USERS
app.post('/api/admin/config/users', async (req, res) => {
    try {
        const { hotelId, users, createdBy } = req.body;

        if (!hotelId || !users || !Array.isArray(users)) {
            return res.status(400).json({ error: 'Données invalides ou liste utilisateurs absente.' });
        }

        const processedUsers = await Promise.all(users.map(async (user, index) => {
            const isHashed = user.password && user.password.startsWith('$2a$');
            const hashedPassword = isHashed ? user.password : await bcrypt.hash(user.password || '123456', 10);

            return {
                ...user,
                id: user.id || ('usr_' + Date.now() + '_' + index + '_' + Math.random().toString(36).substr(2, 4)),
                password: hashedPassword,
                passwordHash: hashedPassword,
                createdBy: user.createdBy || createdBy || 'Superadmin',
                createdAt: user.createdAt || new Date().toISOString()
            };
        }));

        await db.collection('hotels').doc(hotelId).collection('config').doc('users').set({
            hotelId,
            users: processedUsers,
            updatedAt: new Date().toISOString()
        });

        res.json({ message: 'Importation enregistrée avec hachage et IDs uniques', users: processedUsers });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. AUTRES CONFIGURATIONS (ROLES, STRUCTURE)
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
        } else if (status === 'Ouvert') {
            if (ticket.status === 'Résolu' && userRole !== 'admin') {
                return res.status(403).json({ success: false, message: 'Seul un administrateur peut réouvrir un ticket résolu.' });
            }
        }

        await ticketRef.update(updateData);
        return res.json({ success: true, message: 'Statut mis à jour !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/tickets/:id', async (req, res) => {
    const ticketId = req.params.id;
    const { hotelId, userRole } = req.body;

    if (!hotelId) return res.status(400).json({ success: false, message: 'ID hôtel manquant.' });

    try {
        const ticketRef = db.collection('hotels').doc(hotelId).collection('tickets').doc(ticketId);
        const doc = await ticketRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, message: 'Ticket introuvable.' });

        const ticket = doc.data();
        if (ticket.status !== 'Ouvert' && userRole !== 'admin') {
            return res.status(403).json({ success: false, message: 'Seul un administrateur peut supprimer ce ticket.' });
        }

        await ticketRef.delete();
        return res.json({ success: true, message: 'Ticket supprimé avec succès !' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// DÉMARRAGE DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur API Room Check démarré sur le port ${PORT}`);
});