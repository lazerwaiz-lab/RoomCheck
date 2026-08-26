// Fichier api.js - Utilisé par toutes tes pages front-end
console.log = console.error = console.warn = console.info = () => {};
async function executeDbAction(action, collectionName, docId, dataPayload = {}, requiredRole = null) {
    // 1. Récupération automatique de la session locale
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const currentHotel = JSON.parse(sessionStorage.getItem('currentHotel') || '{}');

    const userEmail = currentUser.username || currentUser.email;
    const hotelId = currentHotel.id;
    // On prend le rôle affiché/déclaré par le front-end pour vérification BDD
    const frontRole = requiredRole || currentUser.role;

    if (!userEmail || !hotelId) {
        window.location.href = 'index.html';
        return { success: false, message: "Session invalide" };
    }

    // Détection de l'environnement : local vs production Render
const baseUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:3000'
    : 'https://roomcheck-a24u.onrender.com';

    try {
        // 2. Envoi de la demande au serveur Node.js
        const response = await fetch(`${baseUrl}/api/execute-db-action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userEmail: userEmail,
                hotelId: hotelId,
                userRole: frontRole,       // Transmet le rôle que le Front prétend avoir ou exige
                action: action,            // 'CREATE', 'UPDATE', ou 'DELETE'
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