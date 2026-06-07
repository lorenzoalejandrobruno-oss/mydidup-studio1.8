import { firebaseConfig } from './Config.js';
import { DataService } from './DataService.js';

/**
 * Entry Point Principale di didUP NextGen
 */
class App {
    constructor() {
        this.state = {
            schoolData: [],
            currentUser: null,
            currentPeriod: 'intero',
            currentTredYear: localStorage.getItem('myDidupTredYear') || 1,
            provider: null
        };
        this.unsubscribeSync = null;
        // 1. Esponiamo IMMEDIATAMENTE le funzioni per l'HTML (evita ReferenceError)
        this.exposeLegacyFunctions();
        this.init();
    }

    async init() {
        console.log("🚀 didUP NextGen Initialization...");
        
        try {
            // 2. Inizializziamo i servizi
            this.initFirebase();
            this.initAuthListener();
            this.setupEventListeners();
        } catch (error) {
            console.error("❌ Errore durante l'inizializzazione dei servizi:", error);
        }
    }

    initFirebase() {
        if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
        this.auth = firebase.auth();
        this.provider = new firebase.auth.GoogleAuthProvider();
        this.provider.addScope('profile');
        this.provider.addScope('email');
        this.db = firebase.firestore();
        this.dataService = new DataService(this.db); 
    }

    /**
     * Inizializza il listener per i cambiamenti dello stato di autenticazione.
     */
    initAuthListener() {
        this.auth.onAuthStateChanged(user => {
            this.handleAuthStateChange(user);
        });
    }

    /**
     * Gestisce i cambiamenti dello stato di autenticazione dell'utente.
     * @param {firebase.User} user - L'oggetto utente di Firebase.
     */
    handleAuthStateChange(user) {
        window.currentUser = user; // Espone l'utente a livello globale per script.js
        this.state.currentUser = user;
        const authBox = document.getElementById('auth-box');
        const profileBox = document.getElementById('user-profile-box');
        const logoutBtn = document.getElementById('btn-logout');
        const verifySec = document.getElementById('verification-section');
        
        if (user) {
            if(authBox) authBox.style.setProperty('display', 'none', 'important');
            if(profileBox) profileBox.style.display = 'flex'; 
            if(logoutBtn) logoutBtn.style.display = 'block';
            if (verifySec) verifySec.style.display = user.emailVerified ? 'none' : 'block';

            // Chiamate temporanee a funzioni globali di script.js
            if (window.updateUserUI) window.updateUserUI(user.displayName || "STUDENTE", localStorage.getItem('myDidupUserClass') || ""); // Aggiunto per coerenza
            this.startSync(user);
        } else {
            if(authBox) authBox.style.setProperty('display', 'block');
            if(profileBox) profileBox.style.display = 'none';
            if(logoutBtn) logoutBtn.style.display = 'none';
            if(verifySec) verifySec.style.display = 'none';

            const savedName = localStorage.getItem('myDidupUserName') || "";
            const savedClass = localStorage.getItem('myDidupUserClass') || ""; // Aggiunto per coerenza
            if (window.updateUserUI) window.updateUserUI(savedName, savedClass);
            if (window.recalculateDesktopSystem) window.recalculateDesktopSystem();
            this.stopSync();
        }
    }

    /**
     * Attiva la sincronizzazione in tempo reale con Firestore.
     */
    startSync(user) {
        if (this.unsubscribeSync) this.unsubscribeSync();
        
        console.log("🔄 Avvio sincronizzazione real-time...");
        this.unsubscribeSync = this.db.collection("users").doc(user.uid).onSnapshot(doc => {
            if (doc.exists) {
                const data = doc.data();
                if (window.syncFromCloud) window.syncFromCloud(data);
            }
        }, error => {
            console.error("❌ Errore sincronizzazione:", error);
            if (error.code === 'permission-denied') {
                if (window.showToast) window.showToast("Sincronizzazione disabilitata: permessi insufficienti.", "error");
            }
        });
    }

    /**
     * Ferma la sincronizzazione attiva.
     */
    stopSync() {
        if (this.unsubscribeSync) {
            this.unsubscribeSync();
            this.unsubscribeSync = null;
            console.log("🛑 Sincronizzazione fermata.");
        }
    }

    async handleAuth() {
        try { 
            console.log("🔑 Avvio accesso con Google...");
            await this.auth.signInWithPopup(this.provider); 
        } 
        catch (error) { console.error("❌ Errore Firebase Auth:", error); if (window.showToast) window.showToast("Errore durante l'accesso: " + error.message, "error"); }
    }

    /**
     * Salva i dati correnti sul Cloud Firestore.
     * Accede alle variabili globali di script.js (schoolData, etc.)
     */
    async saveDataToCloud() {
        if (!this.state.currentUser) return;
        try {
            const tredYear = parseInt(localStorage.getItem('myDidupTredYear')) || 1;
            const yearKey = `tred${tredYear}`;
            const updateData = {
                currentTredYear: tredYear,
                [yearKey]: {
                    schoolData: window.schoolData || [],
                    homeworkTasks: window.homeworkTasks || [],
                    reminderTasks: window.reminderTasks || [],
                    systemEvents: window.systemEvents || [],
                    attendanceEvents: window.attendanceEvents || [],
                    schoolTimetable: window.schoolTimetable || {},
                    schoolVacations: window.schoolVacations || [],
                    subjectMaterials: window.subjectMaterials || []
                },
                lastUpdated: new Date().toISOString(),
                userName: localStorage.getItem('myDidupUserName'),
                userClass: localStorage.getItem('myDidupUserClass'),
            };
            await this.db.collection("users").doc(this.state.currentUser.uid).set(updateData, { merge: true });
            console.log("☁️ Cloud Sync (AppInstance): Success");
        } catch (error) {
            console.error("❌ Cloud Save Error:", error);
        }
    }

    async logout() { await this.auth.signOut(); if (window.showToast) window.showToast("Disconnesso. I dati locali rimarranno salvati."); location.reload(); }


    /**
     * Espone le funzioni al window object per compatibilità con onclick nell'HTML
     */
    exposeLegacyFunctions() {
        window.clearLocalCache = async () => {
            const btn = document.querySelector('.header-reset-btn');
            if (btn) btn.classList.add('animating');

            if(confirm("⚠ ATTENZIONE: Questa operazione eliminerà tutti i voti, le materie e le impostazioni salvate localmente. Vuoi procedere?")) {
                try {
                    // 1. Rimuove i Service Worker per evitare il caricamento di versioni vecchie
                    if (window.navigator.serviceWorker) {
                        const registrations = await window.navigator.serviceWorker.getRegistrations();
                        for (let registration of registrations) {
                            await registration.unregister();
                        }
                    }
                    // 2. Svuota la cache dei file (CacheStorage)
                    if (window.caches) {
                        const keys = await window.caches.keys();
                        for (let key of keys) {
                            await window.caches.delete(key);
                        }
                    }
                    // 3. Pulisce il localStorage
                    localStorage.clear();
                    // 4. Forza il ricaricamento bypassando la cache e aggiungendo un parametro anti-cache
                    window.location.href = window.location.pathname + '?refresh=' + Date.now();
                } catch (e) {
                    console.error("Errore durante il reset:", e);
                    localStorage.clear();
                    location.reload();
                }
            }
        };

        // Esposizione delle funzioni di autenticazione
        window.handleAuth = () => this.handleAuth();
        window.logout = () => this.logout();
        window.saveDataToCloud = () => this.saveDataToCloud(); // Espone la funzione per script.js
        window.openModal = (id) => document.getElementById(id)?.classList.add('open');
        window.closeModal = (id) => document.getElementById(id)?.classList.remove('open');
        // Altre funzioni legacy verranno esposte qui man mano che vengono migrate
    }

    setupEventListeners() {
        // Esempio di gestione eventi moderna al posto degli onclick in HTML
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });
    }

    closeAllModals() {
        document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
    }
}

// Bootstrapping
// Bootstrapping immediato
window.AppInstance = new App();