// Fichier api.js - Utilisé par toutes tes pages front-end


window.executeDbAction = async function executeDbAction(action, collectionName, docId, dataPayload = {}, requiredRole = null) {
    // 1. Autoriser explicitement les actions publiques sans session active
    const isPublicAction = (action === 'GET_USER_NAME' || action === 'REQUEST_PASSWORD_RESET');

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

    const isLocal = window.location.hostname === 'localhost' || 
                window.location.hostname === '127.0.0.1' || 
                window.location.hostname === '';

const baseUrl = isLocal
    ? window.location.origin
    : 'https://roomcheck-a24u.onrender.com';

    try {
        // 3. Choix dynamique de l'URL et du corps de la requête selon l'action
        const url = isPublicAction ? `${baseUrl}/api/public-action` : `${baseUrl}/api/execute-db-action`;
        
        const requestBody = isPublicAction ? {
            action: action,
            dataPayload: dataPayload
        } : {
            userEmail: userEmail,
            hotelId: hotelId,
            userRole: frontRole,
            action: action,
            collectionName: collectionName,
            docId: docId,
            dataPayload: dataPayload
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();
        return result;

    } catch (error) {
        console.error("Erreur fetch executeDbAction:", error);
        return { success: false, message: "Erreur serveur" };
    }
};