/**
 * Gestore della persistenza dati (LocalStorage e Firestore)
 */
export class DataService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Salva i dati sul Cloud
     */
    async saveToCloud(uid, data, tredYear) {
        if (!uid) return;
        try {
            const yearKey = `tred${tredYear}`;
            const updateData = {
                [yearKey]: data,
                lastUpdated: new Date().toISOString(),
                userName: localStorage.getItem('myDidupUserName'),
                userClass: localStorage.getItem('myDidupUserClass'),
            };
            await this.db.collection("users").doc(uid).set(updateData, { merge: true });
            console.log("☁️ Cloud Sync: Success");
            return true;
        } catch (error) {
            console.error("❌ Cloud Save Error:", error);
            throw error;
        }
    }

    /**
     * Recupera i dati dal Cloud
     */
    async loadFromCloud(uid) {
        if (!uid) return null;
        try {
            const doc = await this.db.collection("users").doc(uid).get();
            if (doc.exists) {
                return doc.data();
            }
            return null;
        } catch (error) {
            console.error("❌ Cloud Load Error:", error);
            throw error;
        }
    }

    static getTredKey(key, year) {
        return `tred${year}_${key}`;
    }
}