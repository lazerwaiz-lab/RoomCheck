// Fichier api.js - Utilisé par toutes tes pages front-end


async function executeDbAction(action, collectionName, docId, dataPayload = {}, requiredRole = null) {
    // 1. Autoriser explicitement l'action publique sans session active
    const isPublicAction = (action === 'GET_USER_NAME');

    // 2. Récupération automatique de la session locale
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const currentHotel = JSON.parse(sessionStorage.getItem('currentHotel') || '{}');

    const userEmail = currentUser.username || currentUser.email || (isPublicAction ? 'public@roomcheck.local' : '');
    const hotelId = currentHotel.id || (isPublicAction ? 'public' : '');

    // --- GESTION DES RÔLES MULTIPLES ---
    let rawRole = requiredRole || currentUser.role || currentUser.roles || '';
    let frontRole = rawRole;

    if (Array.isArray(rawRole)) {
        frontRole = rawRole.join(', ');
    }
    // -----------------------------------

    // Si ce n'est PAS une action publique et qu'il manque des infos de session, on bloque
    if (!isPublicAction && (!userEmail || !hotelId)) {
        window.location.href = 'index.html';
        return { success: false, message: "Session invalide" };
    }

    // Détection robuste : si on est en local (localhost, 127.0.0.1, ou port Live Preview type 3001/5500)
    const isLocal = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' || 
                    window.location.hostname === '';

    const baseUrl = isLocal
        ? 'http://127.0.0.1:3000'
        : 'https://roomcheck-a24u.onrender.com';

    try {
        // 3. Envoi de la demande au serveur Node.js
        const response = await fetch(`${baseUrl}/api/execute-db-action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userEmail: userEmail,
                hotelId: hotelId,
                userRole: frontRole,       // Transmet les rôles multiples proprement
                action: action,            // 'CREATE', 'UPDATE', 'DELETE', ou 'GET_USER_NAME'
                collectionName: collectionName, // Ex: 'tickets', 'rooms', etc.
                docId: docId,              // ID du document ciblé
                dataPayload: dataPayload   // Données à modifier/créer
            })
        });

        const result = await response.json();
        return result;

    } catch (error) {
        return { success: false, message: "Erreur serveur" };
    }
}