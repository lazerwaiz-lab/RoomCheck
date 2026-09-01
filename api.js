// Fichier api.js - Utilisé par toutes tes pages front-end


window.executeDbAction = async function executeDbAction(action, collectionName, docId = null, dataPayload = {}, requiredRole = null) {
    const isPublicAction = (action === 'GET_USER_NAME');

    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const currentHotel = JSON.parse(sessionStorage.getItem('currentHotel') || '{}');

    const userEmail = currentUser.username || currentUser.email || (isPublicAction ? 'public@roomcheck.local' : '');
    const hotelId = currentHotel.id || (isPublicAction ? 'public' : '');

    let rawRole = requiredRole || currentUser.role || currentUser.roles || '';
    let frontRole = rawRole;

    if (Array.isArray(rawRole)) {
        frontRole = rawRole.join(', ');
    }

    if (!isPublicAction && (!userEmail || !hotelId)) {
        window.location.href = 'index.html';
        return { success: false, message: "Session invalide" };
    }

    const isLocal = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' || 
                    window.location.hostname === '';

    const baseUrl = isLocal ? 'http://127.0.0.1:3000' : 'https://roomcheck-a24u.onrender.com';

    try {
        const response = await fetch(`${baseUrl}/api/execute-db-action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userEmail: userEmail,
                hotelId: hotelId,
                userRole: frontRole,
                action: action,
                collectionName: collectionName,
                docId: docId,
                dataPayload: dataPayload
            })
        });

        return await response.json();

    } catch (error) {
        return { success: false, message: "Erreur serveur" };
    }
};