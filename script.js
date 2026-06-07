/**
 * Forza il caricamento dell'ultima versione del sito bypassando la cache del browser e del Service Worker.
 * A differenza del Reset, non cancella i dati salvati (voti, materie, etc).
 */
function refreshApp() {
    // Aggiunge l'animazione di rotazione all'icona
    const icon = document.getElementById('refresh-icon');
    if (icon) icon.classList.add('spinning');

    const forceReload = () => {
        window.location.href = window.location.pathname + '?update=' + Date.now();
    };

    // Metodo aggressivo: disregistriamo il service worker e svuotiamo la cache dei file
    if ('serviceWorker' in navigator && 'caches' in window) {
        Promise.all([
            navigator.serviceWorker.getRegistrations().then(regs => {
                return Promise.all(regs.map(reg => reg.unregister()));
            }),
            caches.keys().then(keys => {
                return Promise.all(keys.map(key => caches.delete(key)));
            })
        ]).then(forceReload).catch(forceReload);
    } else {
        forceReload();
    }
}

/**
 * Converte un valore numerico nel formato scolastico (+, ½, -)
 * solo per la visualizzazione nelle liste e nei riepiloghi.
 */
function formatGradeDisplay(val) {
    if (val === '-' || val === '+' || val === 'G' || val === null || val === undefined) return val;
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    
    const integerPart = Math.floor(num);
    const decimalPart = parseFloat((num - integerPart).toFixed(2));

    if (decimalPart === 0.15) return integerPart + "+";
    if (decimalPart === 0.50) return integerPart + "½";
    if (decimalPart === 0.85) return (integerPart + 1) + "-";
    
    return num.toString();
}

const parseDateSafe = (d) => new Date(d.replace(/-/g, "/"));

// =======================================================
window.currentUser = null; // Ora è una variabile globale accessibile

// =======================================================
// 1. DATABASE E INIZIALIZZAZIONE
// =======================================================
const defaultSubjects = [
    { id: 9, name: "ARTE", target: 6, color: "#FF9500", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 2, name: "FISICA", target: 6, color: "#AF52DE", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 3, name: "INFORMATICA", target: 7, color: "#007AFF", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 4, name: "LINGUA E LETTERATURA INGLESE", target: 6, color: "#5856D6", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 5, name: "LINGUA E LETTERATURA ITALIANA", target: 6, color: "#FF3B30", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 6, name: "MATEMATICA", target: 6, color: "#34C759", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 7, name: "STORIA E GEOGRAFIA", target: 6, color: "#5AC8FA", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 8, name: "SCIENZE MOTORIE E SPORTIVE", target: 8, color: "#FF2D55", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
    { id: 1, name: "Scienze della Terra", target: 6, color: "#FFCC00", grades: [], scrutinio: { primo: { voto: '-', assenze: 0 }, secondo: { voto: '-', assenze: 0 } } },
];

let currentTredYear = localStorage.getItem('myDidupTredYear') || 1;
let calendarReferenceDate = null;
let selectedDiarioDate = new Date().toISOString().split('T')[0];
let cloudConnectionStatus = navigator.onLine ? 'online' : 'offline';
window.homeworkTasks = [];
window.reminderTasks = [];
window.systemEvents = [];
window.attendanceEvents = [];
window.schoolTimetable = {};
window.schoolVacations = [];
window.subjectMaterials = [];
window.schoolData = []; 
let navSettings = { slot1: 'home', slot2: 'diario', slot3: 'voti', hideLabels: false };
let simulatedValues = {}; 

function getTredKey(key) { return `tred${currentTredYear}_${key}`; }

// ========================================================
// 1.5 MOTORE DI CALCOLO
// ========================================================
function recalculateDesktopSystem() {
    let grandTotal = 0, grandCount = 0, predTotal = 0, predCount = 0;
    let monthlyBucket = { 9:[], 10:[], 11:[], 12:[], 1:[], 2:[], 3:[], 4:[], 5:[], 6:[] };
    let hasAnyGradesInPeriod = false;

    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        if (fGrades.length > 0) {
            const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
            if (totalWeight > 0) {
                let subAvg = weightedSum / totalWeight;
                grandTotal += subAvg; 
                grandCount++;
                let pAvg = simulatedValues[sub.id] ? (weightedSum + simulatedValues[sub.id]) / (totalWeight + 1) : subAvg;
                predTotal += pAvg; predCount++;
            } else if (simulatedValues[sub.id]) {
                predTotal += simulatedValues[sub.id]; predCount++;
            }
            fGrades.forEach(g => { 
                const val = parseFloat(g.value);
                if (!isNaN(val)) {
                    if (monthlyBucket[g.month]) monthlyBucket[g.month].push(val); 
                    hasAnyGradesInPeriod = true;
                }
            });
        } else if (simulatedValues[sub.id]) {
            predTotal += simulatedValues[sub.id]; predCount++;
        }
    });

    let numericAvg = grandCount > 0 ? grandTotal / grandCount : 0;
    updateGlobalAverageUI(numericAvg, grandCount);
    updatePredictedAverageUI(predTotal, predCount);
    renderAllDashboardSections(numericAvg, monthlyBucket, hasAnyGradesInPeriod);
    renderWeeklyCalendar();
    updateHomeHeaderTimestamp(); 
}

function initializeSchoolData() {
    // Inizializza il tema salvato
    const savedTheme = localStorage.getItem('didup-theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeUI(savedTheme);

    // Caricamento dati basato sull'anno corrente
    schoolData = JSON.parse(localStorage.getItem(getTredKey('myDidupDataDesktop'))) || [...defaultSubjects];
    homeworkTasks = JSON.parse(localStorage.getItem(getTredKey('myDidupHomeworkDesktop'))) || [];
    reminderTasks = JSON.parse(localStorage.getItem(getTredKey('myDidupRemindersDesktop'))) || [];
    systemEvents = JSON.parse(localStorage.getItem(getTredKey('myDidupEventsDesktop'))) || [];
    attendanceEvents = JSON.parse(localStorage.getItem(getTredKey('myDidupAttendanceDesktop'))) || [];
    schoolTimetable = JSON.parse(localStorage.getItem(getTredKey('myDidupTimetableDesktop'))) || {};
    schoolVacations = JSON.parse(localStorage.getItem(getTredKey('myDidupVacationsDesktop'))) || [];
    subjectMaterials = JSON.parse(localStorage.getItem(getTredKey('myDidupMaterialsDesktop'))) || [];

    if (!localStorage.getItem(getTredKey('myDidupDataDesktop'))) {
        localStorage.setItem(getTredKey('myDidupDataDesktop'), JSON.stringify(schoolData));
    }

    // Carica impostazioni periodi
    const termSettings = JSON.parse(localStorage.getItem(getTredKey('myDidupTermDates'))) || {
        p1_start: '2025-09-12', p1_end: '2026-01-31', p2_end: '2026-06-08'
    };
    if(document.getElementById('term1-start')) document.getElementById('term1-start').value = termSettings.p1_start;
    if(document.getElementById('term1-end')) document.getElementById('term1-end').value = termSettings.p1_end;
    if(document.getElementById('term2-end')) document.getElementById('term2-end').value = termSettings.p2_end;

    const savedNav = JSON.parse(localStorage.getItem('myDidupNavSettings'));
    if (savedNav) navSettings = { ...navSettings, ...savedNav };
    if(document.getElementById('input-nav-1')) document.getElementById('input-nav-1').value = navSettings.slot1;
    if(document.getElementById('input-nav-2')) document.getElementById('input-nav-2').value = navSettings.slot2;
    if(document.getElementById('input-nav-3')) document.getElementById('input-nav-3').value = navSettings.slot3;
    if(document.getElementById('input-hide-nav-labels')) document.getElementById('input-hide-nav-labels').checked = navSettings.hideLabels || false;

    renderBottomNav();
    updateTredYearUI();
    recalculateDesktopSystem();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeSchoolData();

    // Configurazione PDF.js (spostato qui per assicurarsi che pdfjsLib sia caricato)
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    
    const today = new Date().toISOString().substring(0, 10);
    ['hw-date', 'rem-date', 'event-date', 'att-date', 'grade-date'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = today;
    });

    // Monitoraggio stato connessione
    window.addEventListener('online', () => updateCloudStatusUI('online'));
    window.addEventListener('offline', () => updateCloudStatusUI('offline'));
    updateCloudStatusUI(navigator.onLine ? 'online' : 'offline');

    const updateStatusDisplay = () => {
        const d = new Date(); // This was inside setInterval, moved outside for initial call
        const ts = document.getElementById('live-timestamp-desktop');
        const statusText = cloudConnectionStatus === 'online' ? 'Sincronizzato' : 'Offline';
        if(ts) ts.innerText = `${statusText} • ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    };

    updateStatusDisplay();
    setInterval(() => {
        updateStatusDisplay();
        const d = new Date();
        if (d.getSeconds() === 0 && document.getElementById('tab-orario').classList.contains('active')) {
            renderTimetable();
        }
    }, 1000);

    document.addEventListener("keydown", (e) => {
        if (e.key === 'Escape') {
            const activeModal = document.querySelector('.modal.open');
            if (activeModal) closeModal(activeModal.id);
            document.getElementById('menu-overlay').classList.remove('open');
            document.getElementById('btn-nav-menu').classList.remove('active');
            document.body.classList.remove('sidebar-open');
        } else if (e.key === 'Enter') {
            const gradeModal = document.getElementById('grade-modal');
            if (gradeModal && gradeModal.classList.contains('open')) {
                // Prevent default to avoid form submission or new line in textarea
                e.preventDefault();
                saveGrade();
            }
        }
    });

    initSwipeToClose();

    // Attacca l'event listener per il pulsante sidebar-toggle
    const sidebarToggleButton = document.getElementById('sidebar-toggle-btn');
    if (sidebarToggleButton) {
        sidebarToggleButton.addEventListener('click', toggleSidebar);
    }

    initSwipeToClose(); // Re-inizializza per includere il nuovo modale

    // Chiudi la sidebar cliccando fuori su desktop/mobile
    document.addEventListener('click', (e) => {
        const sidebar = document.querySelector('.sidebar');
        const toggle = document.querySelector('.sidebar-toggle');
        if (document.body.classList.contains('sidebar-open') && 
            !sidebar.contains(e.target) && 
            !toggle.contains(e.target)) {
            document.body.classList.remove('sidebar-open');
        }
    });

    // Gestione anteprima dinamica voti e annotazioni nel modale
    const gradeInp = document.getElementById('grade-value');
    const annoSel = document.getElementById('grade-annotation-select');
    const preview = document.getElementById('grade-graphic-display');

    const updatePreview = () => {
        const modal = document.getElementById('grade-modal');
        if (modal.classList.contains('annotation-mode')) {
            const val = annoSel.value;
            preview.innerText = val === '+' || val === '-' || val === 'G' ? val : val.charAt(0);
            preview.className = 'grade-bubble ' + (val === '+' ? 'g-green' : (val === '-' ? 'g-red' : 'g-grey'));
        } else {
            const val = parseFloat(gradeInp.value);
            preview.innerText = isNaN(val) ? '-' : formatGradeDisplay(val);
            if (preview.style.display === 'none') preview.style.display = 'flex';
            preview.className = 'grade-bubble ' + (isNaN(val) ? 'g-grey' : (val >= 6 ? 'g-green' : (val >= 5 ? 'g-orange' : 'g-red')));
        }
    };

    if (gradeInp) gradeInp.addEventListener('input', updatePreview);
    if (annoSel) annoSel.addEventListener('change', updatePreview);

    // Avvia la gestione asincrona di Auth
}); // End of DOMContentLoaded

// ========================================================
// 2. STATO APPLICAZIONE E FUNZIONI
// ========================================================

/**
 * Inizializza la logica di swipe-to-close per i modali su mobile.
 */
function initSwipeToClose() {
    let touchStartY = 0;
    let touchMoveY = 0;

    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        const content = modal.querySelector('.modal-content');
        const modalBody = modal.querySelector('.modal-body');
        if (!content) return;

        content.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 768) return;
            touchStartY = e.touches[0].clientY;
            content.style.transition = 'none'; // Disabilita animazioni durante il trascinamento
        }, { passive: true });

        content.addEventListener('touchmove', (e) => {
            if (window.innerWidth > 768) return;
            touchMoveY = e.touches[0].clientY;
            const deltaY = touchMoveY - touchStartY;

            // Chiudi solo se trasciniamo verso il basso e siamo in cima al contenuto
            const isAtTop = !modalBody || modalBody.scrollTop <= 0;
            if (deltaY > 0 && isAtTop) {
                if (e.cancelable) e.preventDefault();
                content.style.transform = `translateY(${deltaY}px)`;
            }
        }, { passive: false });

        content.addEventListener('touchend', () => {
            if (window.innerWidth > 768) return;
            content.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            const deltaY = touchMoveY - touchStartY;

            if (deltaY > 150) { // Soglia per chiudere
                closeModal(modal.id);
                setTimeout(() => { content.style.transform = ''; }, 300);
            } else {
                content.style.transform = 'translateY(0)';
            }
            touchStartY = 0;
            touchMoveY = 0;
        }, { passive: true });
    });
}

let currentPeriod = 'intero';
let currentDiarioView = 'giorno'; 
let currentScrutinioPeriod = 'primo';
let editingSubId = null;
let editingSubjectId = null;
let editingGradeId = null;
let openAccordionId = null; 
let currentSubjectDetailId = null;
let lastAvg = 0; 
let mainChartInstance = null;
let subjectChartInstance = null;
let gradeDistributionChartInstance = null; // Nuova istanza per il grafico a barre
let subjectGradeDistributionChartInstance = null; // Istanza per la distribuzione specifica della materia

function renderTimetable() {
    const grid = document.getElementById('timetable-grid-hook');
    if (!grid) return;
    
    const days = ["LUN", "MAR", "MER", "GIO", "VEN","SAB"];
    const hours = 7;
    
    let html = '<div class="timetable-header">Ora</div>';
    days.forEach(d => html += `<div class="timetable-header">${d}</div>`);
    
    for (let h = 1; h <= hours; h++) {
        html += `<div class="timetable-hour-label">${h}° Ora</div>`;
        for (let d = 0; d < days.length; d++) {
            const cellId = `${d}-${h}`;
            const cellData = schoolTimetable[cellId] || null;
            const currentInfo = isCurrentLesson(d, h);
            
            let styleAttr = "";
            if (cellData) {
                const subObj = schoolData.find(s => s.name === cellData.subject);
                if (subObj) styleAttr = `--sub-color: ${subObj.color};`;
            }
            
            html += `
                <div class="timetable-cell ${cellData ? 'filled' : ''} ${currentInfo.active ? 'current-hour' : ''}" 
                     style="${styleAttr}"
                     onclick="launchTimetableModal(${d}, ${h})">
                    ${cellData ? `
                        <div class="timetable-subject-name">${cellData.subject}</div>
                        <div class="timetable-teacher">${cellData.teacher || ''}</div>
                        <div class="timetable-room">${cellData.room || ''}</div>
                        ${currentInfo.active ? `<div class="lesson-progress-bar" style="width: ${currentInfo.progress}%"></div>` : ''}
                    ` : '<span style="color:#cbd5e0; font-size:18px;">+</span>'}
                </div>
            `;
        }
    }
    grid.innerHTML = html;
}

function isCurrentLesson(dayIdx, hourIdx) {
    const now = new Date();
    const day = now.getDay();
    if (day < 1 || day > 6) return { active: false };
    if ((day - 1) !== dayIdx) return { active: false };

    const timeInMin = now.getHours() * 60 + now.getMinutes();
    const startHour = 8 * 60 + (hourIdx - 1) * 60;
    const endHour = startHour + 60;

    if (timeInMin >= startHour && timeInMin < endHour) {
        const progress = ((timeInMin - startHour) / 60) * 100;
        return { active: true, progress: progress };
    }
    return { active: false };
}

function launchTimetableModal(day, hour) {
    document.getElementById('tt-day-idx').value = day;
    document.getElementById('tt-hour-idx').value = hour;
    const cellId = `${day}-${hour}`;
    const data = schoolTimetable[cellId] || { subject: '', room: '', teacher: '' };
    const sel = document.getElementById('tt-subject-select');
    if(sel) sel.value = data.subject || (schoolData[0]?.name || '');
    const roomInput = document.getElementById('tt-room');
    if(roomInput) roomInput.value = data.room || '';
    const teacherInput = document.getElementById('tt-teacher');
    if(teacherInput) teacherInput.value = data.teacher || '';
    openModal('timetable-modal');
}

function saveTimetableCell() {
    const day = document.getElementById('tt-day-idx').value;
    const hour = document.getElementById('tt-hour-idx').value;
    const subject = document.getElementById('tt-subject-select').value;
    const room = document.getElementById('tt-room').value;
    const teacher = document.getElementById('tt-teacher').value;
    schoolTimetable[`${day}-${hour}`] = { subject, room, teacher };
    updateStorage('myDidupTimetableDesktop', schoolTimetable);
    closeModal('timetable-modal');
    renderTimetable();
}

function clearTimetableCell() {
    const day = document.getElementById('tt-day-idx').value;
    const hour = document.getElementById('tt-hour-idx').value;
    delete schoolTimetable[`${day}-${hour}`];
    updateStorage('myDidupTimetableDesktop', schoolTimetable);
    closeModal('timetable-modal');
    renderTimetable();
}

function switchDesktopTab(tabId) {
    // Se torniamo alla Home, resettiamo il contesto della materia attiva
    if (tabId === 'home') currentSubjectDetailId = null;

    const pages = document.querySelectorAll('.desktop-tab-page');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    
    pages.forEach(page => {
        page.classList.remove('active');
        // Piccolo timeout per permettere al display:none di switchare prima dell'animazione CSS
        setTimeout(() => {
            if (page.id === 'tab-' + tabId) {
                page.classList.add('active');
            }
        }, 10);
    });
    
    const navBtn = document.getElementById('btn-nav-' + tabId);
    if(navBtn) navBtn.classList.add('active');
    
    recalculateDesktopSystem();
    if (document.getElementById('menu-overlay')) {
        document.getElementById('menu-overlay').classList.remove('open');
    }
}

function renderBottomNav() {
    const nav = document.querySelector('.bottom-nav');
    if (!nav) return;

    const hideLabels = navSettings.hideLabels || false;
    if (hideLabels) nav.classList.add('minimalist');
    else nav.classList.remove('minimalist');

    let activeTabId = 'home';
    document.querySelectorAll('.desktop-tab-page').forEach(page => {
        if(page.classList.contains('active')) {
            activeTabId = page.id.replace('tab-', '');
        }
    });

    const emojiMap = {
        'home': '🏠',
        'diario': '📝',
        'voti': '📊',
        'scrutinio': '🎓',
        'eventi': '📢',
        'promemoria': '🔔',
        'appello': '🎒',
        'orario': '📅',
        'condivisione': '📂'
    };

    const navItemMap = {
        'home': { label: 'Home', emoji: emojiMap.home },
        'diario': { label: 'Diario', emoji: emojiMap.diario },
        'voti': { label: 'Voti', emoji: emojiMap.voti },
        'scrutinio': { label: 'Scrutinio', emoji: emojiMap.scrutinio },
        'eventi': { label: 'Eventi', emoji: emojiMap.eventi },
        'promemoria': { label: 'Prove', emoji: emojiMap.promemoria },
        'appello': { label: 'Appello', emoji: emojiMap.appello },
        'orario': { label: 'Orario', emoji: emojiMap.orario },
        'condivisione': { label: 'Files', emoji: emojiMap.condivisione }
    };

    const s1 = navItemMap[navSettings.slot1] || navItemMap['home'];
    const s2 = navItemMap[navSettings.slot2] || navItemMap['diario'];
    const s3 = navItemMap[navSettings.slot3] || navItemMap['voti'];

    nav.innerHTML = `
        <div class="nav-btn ${activeTabId === navSettings.slot1 ? 'active' : ''}" id="btn-nav-${navSettings.slot1}" onclick="switchDesktopTab('${navSettings.slot1}')">
            <span class="nav-btn-icon">${s1.emoji}</span>${hideLabels ? '' : `<span>${s1.label}</span>`}
        </div>
        <div class="nav-btn ${activeTabId === navSettings.slot2 ? 'active' : ''}" id="btn-nav-${navSettings.slot2}" onclick="switchDesktopTab('${navSettings.slot2}')">
            <span class="nav-btn-icon">${s2.emoji}</span>${hideLabels ? '' : `<span>${s2.label}</span>`}
        </div>
        <div class="nav-btn ${activeTabId === navSettings.slot3 ? 'active' : ''}" id="btn-nav-${navSettings.slot3}" onclick="switchDesktopTab('${navSettings.slot3}')">
            <span class="nav-btn-icon">${s3.emoji}</span>${hideLabels ? '' : `<span>${s3.label}</span>`}
        </div>
        <div class="nav-btn" id="btn-nav-menu" onclick="toggleFullMenu()">
            <span class="nav-btn-icon">${hideLabels ? '☰' : ''}</span>${hideLabels ? '' : '<span>Menu</span>'}
        </div>
    `;
}

async function updateStorage(key, data) {
    localStorage.setItem(getTredKey(key), JSON.stringify(data));
    if (currentUser) {
        if (window.AppInstance && window.AppInstance.saveDataToCloud) await window.AppInstance.saveDataToCloud();
    }
    recalculateDesktopSystem();
}

/**
 * Ingerisce i dati provenienti dal Cloud (Firestore Snapshot)
 * e aggiorna lo stato locale e l'interfaccia.
 */
window.syncFromCloud = (cloudData) => {
    if (!cloudData) return;
    
    try {
        // Sincronizza l'anno TrED se diverso da quello locale
        if (cloudData.currentTredYear && cloudData.currentTredYear != currentTredYear) {
            currentTredYear = cloudData.currentTredYear;
            localStorage.setItem('myDidupTredYear', currentTredYear);
            updateTredYearUI();
        }

        const yearKey = `tred${currentTredYear}`;
        const yd = cloudData[yearKey];

        // Aggiorna profilo se i dati cloud sono presenti
        if (cloudData.userName) {
            localStorage.setItem('myDidupUserName', cloudData.userName);
            updateUserUI(cloudData.userName, cloudData.userClass || "");
        }
        if (cloudData.userClass) localStorage.setItem('myDidupUserClass', cloudData.userClass);

        // Ingerimento dati per l'anno scolastico corrente
        if (yd) {
            if (yd.schoolData) schoolData = yd.schoolData;
            if (yd.homeworkTasks) homeworkTasks = yd.homeworkTasks;
            if (yd.reminderTasks) reminderTasks = yd.reminderTasks;
            if (yd.systemEvents) systemEvents = yd.systemEvents;
            if (yd.attendanceEvents) attendanceEvents = yd.attendanceEvents;
            if (yd.schoolTimetable) schoolTimetable = yd.schoolTimetable;
            if (yd.subjectMaterials) subjectMaterials = yd.subjectMaterials;
            if (yd.schoolVacations) schoolVacations = yd.schoolVacations;

            // Aggiorna Storage Locale in modo atomico (senza triggerare un nuovo salvataggio cloud)
            updateLocalStorageAll();
        }

        // Refresh dell'interfaccia
        recalculateDesktopSystem();
        updateTredYearUI();
        
        console.log("☁️ Sync: Dati ricevuti e aggiornati.");
    } catch (e) {
        console.error("❌ Sync Error:", e);
    }
};

/**
 * Funzione di utilità per salvare massivamente tutti i dati nel localStorage
 */
function updateLocalStorageAll() {
    try {
        localStorage.setItem(getTredKey('myDidupDataDesktop'), JSON.stringify(schoolData));
        localStorage.setItem(getTredKey('myDidupHomeworkDesktop'), JSON.stringify(homeworkTasks));
        localStorage.setItem(getTredKey('myDidupRemindersDesktop'), JSON.stringify(reminderTasks));
        localStorage.setItem(getTredKey('myDidupEventsDesktop'), JSON.stringify(systemEvents));
        localStorage.setItem(getTredKey('myDidupAttendanceDesktop'), JSON.stringify(attendanceEvents));
        localStorage.setItem(getTredKey('myDidupTimetableDesktop'), JSON.stringify(schoolTimetable));
        localStorage.setItem(getTredKey('myDidupVacationsDesktop'), JSON.stringify(schoolVacations));
        localStorage.setItem(getTredKey('myDidupMaterialsDesktop'), JSON.stringify(subjectMaterials));
    } catch (e) {
        console.error("Errore durante il salvataggio locale massivo:", e);
    }
}

function updateUserUI(name, uClass) {
    const initial = "🎒"; // Forza l'emoji dello zaino ovunque
    const formattedName = name ? name.toUpperCase() : "STUDENTE";
    
    if(document.getElementById('display-name')) document.getElementById('display-name').innerText = formattedName; // Sidebar
    if(document.getElementById('display-name-welcome')) document.getElementById('display-name-welcome').innerText = formattedName; // Home Welcome
    if(document.getElementById('user-avatar')) document.getElementById('user-avatar').innerHTML = `<img src="https://cdn-icons-png.flaticon.com/512/2940/2940654.png" alt="Zaino" style="width: 24px; height: 24px; filter: brightness(0) invert(1);">`;
    if(document.getElementById('display-name-menu')) document.getElementById('display-name-menu').innerText = formattedName; // Full Menu
    if(document.getElementById('user-avatar-menu')) document.getElementById('user-avatar-menu').innerHTML = `<img src="https://cdn-icons-png.flaticon.com/512/2940/2940654.png" alt="Zaino" style="width: 24px; height: 24px; filter: brightness(0) invert(1);">`;
    if(document.getElementById('display-class')) document.getElementById('display-class').innerText = uClass || "Classe non impostata";
}

function setTredYear(year) {
    currentTredYear = year;
    localStorage.setItem('myDidupTredYear', year);
    initializeSchoolData();
    recalculateDesktopSystem();
    renderTimetable();
    showToast(`Passato all'anno ${year} TrED`, "success");
}

function updateTredYearUI() {
    const btns = document.querySelectorAll('#tred-year-selector .segment-btn');
    btns.forEach(btn => {
        const year = btn.innerText;
        if (year == currentTredYear) btn.classList.add('active');
        else btn.classList.remove('active');
    });
}

function toggleSidebar() {
    document.body.classList.toggle('sidebar-open');
}

function openTargetSidebar(event) {
    if (event) event.stopPropagation(); // Impedisce al click di chiudere la sidebar immediatamente
    document.body.classList.add('sidebar-open');
    
    const targetBox = document.querySelector('.sidebar-target-box');
    const targetInput = document.getElementById('target-avg-input');

    if (targetBox && targetInput) {
        targetBox.classList.add('highlight-focus');
        setTimeout(() => {
            targetInput.focus();
            targetInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); // Usa 'nearest' per migliore compatibilità e visibilità
            setTimeout(() => targetBox.classList.remove('highlight-focus'), 1500); // Rimuovi l'highlight dopo un ritardo
        }, 500); // Attendi l'animazione della sidebar
    }
}

function updateHomeHeaderTimestamp() {
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const dateStr = now.toLocaleDateString('it-IT');
    const subEl = document.getElementById('home-subtitle-display');
    if (subEl) {
        subEl.innerText = `Dati aggiornati alle ${timeStr} del ${dateStr}`;
    }
}

function toggleFullMenu() { 
    const menu = document.getElementById('menu-overlay');
    const btn = document.getElementById('btn-nav-menu');

    if (menu.classList.contains('open')) {
        // Menu is open, so close it
        menu.classList.remove('open');
        btn.classList.remove('active');
        // Quando si chiude il menu, riattiva la tab Home per default
        switchDesktopTab('home'); // Riattiva la tab Home per default
    } else {
        // Menu is closed, so open it
        // Prima di aprire il menu, disattiva tutti gli altri pulsanti di navigazione
        document.querySelectorAll('.nav-btn').forEach(navBtn => navBtn.classList.remove('active'));

        menu.classList.add('open');
        btn.classList.add('active');
    }
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if(!container) return;
    const existing = container.querySelector('.toast');
    if(existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : '❌';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('hide'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function openModal(id) { 
    document.getElementById(id).classList.add('open'); 
    // Chiude il menu overlay se è aperto, per mostrare subito il modale
    const menu = document.getElementById('menu-overlay');
    if (menu && menu.classList.contains('open')) {
        menu.classList.remove('open');
        // Disattiva anche il pulsante "Menu" nella bottom-nav
        const btn = document.getElementById('btn-nav-menu');
        if (btn) btn.classList.remove('active');
    }
    if (id === 'vacations-modal') {
        resetVacationForm();
        renderVacationsList();
    }
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function updateCloudStatusUI(status) {
    cloudConnectionStatus = status;
    const dot = document.querySelector('.pulse-dot');
    const ts = document.getElementById('live-timestamp-desktop');
    const badge = document.getElementById('live-sync-badge');

    if (dot) {
        dot.classList.remove('online', 'offline');
        dot.classList.add(status);
    }
    if (badge) {
        badge.classList.remove('online', 'offline');
        badge.classList.add(status);
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', target);
    localStorage.setItem('didup-theme', target);
    updateThemeUI(target);
    recalculateDesktopSystem(); // Forza il ricaricamento del grafico con i nuovi colori
}

function updateThemeUI(theme) {
    const icon = document.getElementById('theme-toggle-icon');
    const text = document.getElementById('theme-toggle-text');
    if (icon) icon.innerText = theme === 'dark' ? '☀️' : '🌙';
    if (text) text.innerText = theme === 'dark' ? 'Modalità Chiara' : 'Modalità Scura';
}

function filterGradesBySpecificPeriod(grades, period) {
    const termSettings = JSON.parse(localStorage.getItem(getTredKey('myDidupTermDates'))) || {
        p1_start: '2025-09-12', p1_end: '2026-01-31', p2_end: '2026-06-08'
    };
    return grades.filter(g => {
        const gradeTime = new Date(g.date).setHours(0,0,0,0);
        if(period === 'primo') {
            const start = new Date(termSettings.p1_start).setHours(0,0,0,0);
            const end = new Date(termSettings.p1_end).setHours(23,59,59,999);
            return gradeTime >= start && gradeTime <= end;
        }
        if(period === 'secondo') {
            const start = new Date(termSettings.p1_end).setHours(23,59,59,999);
            const end = new Date(termSettings.p2_end).setHours(23,59,59,999);
            return gradeTime > start && gradeTime <= end;
        }
        return true; // intero
    });
}

function renderHomeDetailedAverages() {
    const avgs = { primo: null, secondo: null, intero: null };
    ['primo', 'secondo', 'intero'].forEach(p => {
        let total = 0, count = 0;
        schoolData.forEach(sub => {
            const fGrades = filterGradesBySpecificPeriod(sub.grades || [], p);
            if (fGrades.length > 0) {
                const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
                if (totalWeight > 0) { total += (weightedSum / totalWeight); count++; }
            }
        });
        avgs[p] = count > 0 ? (total / count) : null;
    });

    const hook = document.getElementById('home-averages-period-breakdown');
    if (!hook) return;

    let periodName = currentPeriod === 'primo' ? '1° Quadrimestre' : (currentPeriod === 'secondo' ? '2° Quadrimestre' : 'Intero Anno');
    let html = `<div style="font-size:11px; color:var(--text-sub); line-height: 1.6;">Periodo Attivo: <b>${periodName}</b></div>`;
    
    if (currentPeriod === 'secondo' && avgs.primo) {
        html += `<div>Precedente (1° Quad): <b>${avgs.primo.toFixed(2)}</b></div>`;
    } else if (currentPeriod === 'intero') {
        html += `<div>1° Quad: <b>${avgs.primo?.toFixed(2) || '--'}</b> | 2° Quad: <b>${avgs.secondo?.toFixed(2) || '--'}</b></div>`;
    }
    
    html += `<div style="margin-top:4px; font-weight:800; color:var(--argo-teal);">Media Totale: ${avgs.intero?.toFixed(2) || '--'}</div>`;
    hook.innerHTML = html;
}

function renderHomeTimetable() {
    const hook = document.getElementById('home-today-timetable-hook');
    if (!hook) return;
    const dayOfWeek = new Date().getDay(); // 0=Dom, 1=Lun...
    if (dayOfWeek === 0 || dayOfWeek === 6) return hook.innerHTML = '<p class="empty-placeholder">Oggi è weekend! Riposo.</p>';
    
    const lessons = [];
    for (let h = 1; h <= 7; h++) {
        const cell = schoolTimetable[`${dayOfWeek - 1}-${h}`];
        if (cell) {
            const subObj = schoolData.find(s => s.name === cell.subject);
            lessons.push({ hour: h, color: subObj?.color || 'var(--argo-blue-text)', ...cell });
        }
    }
    hook.innerHTML = lessons.map(l => ` 
        <div class="scroll-card" style="min-width:160px; border-left: 4px solid ${l.color};">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="font-size:10px; font-weight:800; color:#64748b;">${l.hour}° ORA</div>
                <div style="font-size:9px; background:rgba(0,0,0,0.05); padding:2px 5px; border-radius:4px;">${l.room || ''}</div>
            </div>
            <div style="font-size:14px; font-weight:800; margin-top:8px; color:var(--text-main);">${l.subject}</div>
            <div style="font-size:11px; color:var(--text-sub); margin-top:2px;">${l.teacher || ''}</div>
        </div>
    `).join('') || '<p class="empty-placeholder">Nessuna lezione in programma oggi.</p>';
}

function renderHomePendingHomework() {
    const hook = document.getElementById('home-homework-scroll'); // Corretto l'ID
    if (!hook) return;
    const now = new Date().setHours(0,0,0,0);
    const pending = homeworkTasks.filter(t => new Date(t.expiry).getTime() >= now).sort((a,b) => new Date(a.expiry) - new Date(b.expiry));
    hook.innerHTML = pending.map(t => `
        <div class="scroll-card">
            <div class="card-meta-row"><div class="mini-icon i-blue">📖</div><span class="subj-tag">${t.subject}</span></div>
            <p class="task-title" style="margin-bottom:8px;">${t.title}</p>
            <div class="diario-card-footer"><span>📅 ${t.expiry}</span></div>
        </div>
    `).join('') || '<p class="empty-placeholder">Nessun compito in sospeso.</p>';
}

function filterGradesByPeriod(grades) {
    const termSettings = JSON.parse(localStorage.getItem(getTredKey('myDidupTermDates'))) || {
        p1_start: '2025-09-12', p1_end: '2026-01-31', p2_end: '2026-06-08'
    };
    
    return grades.filter(g => {
        // Usiamo un confronto basato su stringhe o timestamp puliti per evitare bug di fuso orario
        const gradeTime = new Date(g.date).setHours(0,0,0,0);
        if(currentPeriod === 'primo') {
            const start = new Date(termSettings.p1_start).setHours(0,0,0,0);
            const end = new Date(termSettings.p1_end).setHours(23,59,59,999);
            return gradeTime >= start && gradeTime <= end;
        }
        if(currentPeriod === 'secondo') {
            const start = new Date(termSettings.p1_end).setHours(23,59,59,999); // Inizia subito dopo il 1°
            const end = new Date(termSettings.p2_end).setHours(23,59,59,999);
            return gradeTime > start && gradeTime <= end;
        }
        return true;
    });
}

function calculateWeightedMetrics(grades) {
    return grades.reduce((acc, g) => {
        const val = parseFloat(g.value);
        if (isNaN(val)) return acc; // Salta annotazioni e giudizi non numerici nei calcoli
        const weight = (g.weight === 0 ? 0 : (parseFloat(g.weight) || 100)) / 100;
        acc.weightedSum += (val * weight);
        acc.totalWeight += weight;
        return acc;
    }, { weightedSum: 0, totalWeight: 0 });
}

/**
 * Calcola la somma e il conteggio di tutti i voti individuali numerici
 * in tutte le materie per il periodo corrente, ignorando i pesi.
 * Utilizzato per calcolare il voto necessario per la media generale.
 * @returns {{totalGradesCount: number, totalGradesSum: number}}
 */
function calculateTotalIndividualGradesMetrics() {
    let totalGradesCount = 0;
    let totalGradesSum = 0;
    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        fGrades.forEach(g => { const val = parseFloat(g.value); if (!isNaN(val)) { totalGradesCount++; totalGradesSum += val; } });
    });
    return { totalGradesCount, totalGradesSum };
}

function updateGlobalAverageUI(numericAvg, grandCount) {
    const avgDisplay = document.getElementById('global-average-display');
    const circleStroke = document.getElementById('avg-circle-stroke');
    
    if (avgDisplay && lastAvg > 0 && Math.abs(numericAvg - lastAvg) > 0.001) {
        const isUp = numericAvg > lastAvg;
        toggleAvgAnimation(avgDisplay, circleStroke, isUp);
    }
    
    lastAvg = numericAvg;
    const circumference = 282.74; // Per un raggio di 45
    const percent = Math.min(Math.max(numericAvg / 10, 0), 1);
    const offset = circumference - (percent * circumference);

    if(circleStroke) {
        circleStroke.style.strokeDashoffset = offset; // Corretto per usare l'offset calcolato
        circleStroke.style.stroke = numericAvg >= 6 ? "#34C759" : (numericAvg >= 5 ? "#FF914D" : "#FF3B30");
    }

    if(avgDisplay) avgDisplay.innerText = grandCount > 0 ? numericAvg.toFixed(2) : "--";
}

function toggleAvgAnimation(display, border, isUp) {
    display.classList.remove('avg-up', 'avg-down');
    if (border) border.classList.remove('circle-up', 'circle-down'); // Rimosso per coerenza con il nuovo SVG
    void display.offsetWidth;
    display.classList.add(isUp ? 'avg-up' : 'avg-down');
    // if (border) border.classList.add(isUp ? 'circle-up' : 'circle-down'); // Rimosso per coerenza con il nuovo SVG
}

function updatePredictedAverageUI(predTotal, predCount) {
    const predDisp = document.getElementById('predicted-avg-display');
    if(predDisp) predDisp.innerText = predCount > 0 ? `Prev: ${(predTotal / predCount).toFixed(2)}` : "Prev: --";
}

function renderAllDashboardSections(numericAvg, monthlyBucket, hasData) {
    // Aggiorna il quadratino (rettangolino) nel grafico
    const badge = document.getElementById('voti-period-average-badge');
    if(badge) badge.innerText = hasData ? `Media Periodo: ${numericAvg.toFixed(2)}` : "Media Periodo: N.D.";

    const bannerCont = document.getElementById('tab-voti-header-info');
    if(bannerCont) {
        const periodName = currentPeriod === 'primo' ? '1° Quadrimestre' : (currentPeriod === 'secondo' ? '2° Quadrimestre' : 'Intero Anno');
        bannerCont.innerHTML = ` 
            <div class="registry-summary-banner">
                <h3>La tua media è ${hasData ? numericAvg.toFixed(2) : '--'}</h3>
                <p>Calcolata nel periodo: <b>${periodName}</b></p>
            </div>
        `;
    }
    
    populateSubjectSelects();
    renderHomeScrollSections();
    renderDiarioSection();
    renderRemindersSection();
    renderEventsSection();
    renderAppelloSection();
    renderScrutinioTable();
    renderCondivisione();
    renderSubjectsAccordion();
    renderTimetable();
    populateTimetableSelects();
    renderAttendancePieChart();
    drawAreaChart(monthlyBucket, hasData);
    renderTargetAnalysis(numericAvg);
    renderGradeDistributionBarChart(calculateGradeDistribution(currentPeriod)); // Aggiunto il rendering del grafico a barre
    renderStudyHistoryChart();
    renderStudyAdvisor();
    renderWeeklyGoals();
}

function renderWeeklyGoals() {
    const items = getWeeklyStudyPlan(); // Usa la nuova funzione per il piano di studio settimanale
    const hook = document.getElementById('weekly-goals-hook');
    const sec = document.getElementById('weekly-goals-section');

    if (items.length > 0) {
        let html = `<h4 style="margin-bottom:10px; font-size:14px; color:var(--argo-blue-text);">Obiettivi della Settimana:</h4>`;
        items.forEach(item => {
            const prioClass = item.priority === 'Alta' ? 'p-high' : 'p-med';
            html += `
                <div class="diario-card-slim card">
                    <div class="header-icon i-blue" style="width:40px; height:40px; font-size:16px;">🎯</div>
                    <div style="flex:1">
                        <div style="font-size:13px; font-weight:800; color:var(--text-main);">${item.name}</div>
                        <div style="font-size:11px; color:var(--text-sub);">${item.reason}</div>
                    </div>
                    <div style="text-align:right">
                        <div style="font-size:12px; font-weight:800; color:var(--primary-orange);">${item.hours}</div>
                        <div style="font-size:9px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">${item.studyDay}</div>
                    </div>
                </div>
            `;
        });
        if (hook) hook.innerHTML = html;
        if (sec) sec.style.display = 'block';
    } else {
        if (hook) hook.innerHTML = '<p class="empty-placeholder">Nessun obiettivo di studio per questa settimana. Ottimo lavoro!</p>';
        if (sec) sec.style.display = 'none';
    }
}

function renderStudyAdvisor() {
    const items = getGeneralStudyRecommendations(3); // Questa funzione rimane invariata per l'advisor generale
    const planHTML = generateStudyPlanHTML(items, "Analisi per oggi:");

    const homeCont = document.getElementById('study-advisor-home-container');
    const homeHook = document.getElementById('study-plan-hook-home');
    const diarioHook = document.getElementById('study-plan-hook-diario');

    if (homeHook) homeHook.innerHTML = planHTML;
    if (diarioHook) diarioHook.innerHTML = planHTML;
    
    if (homeCont) {
        homeCont.style.display = items.length > 0 ? 'block' : 'none';
    }
}

function renderHomeScrollSections() {
    const counts = attendanceEvents.reduce((acc, curr) => {
        if(curr.type === 'Assenza') acc.a++;
        if(curr.type === 'Ritardo') acc.r++;
        if(curr.type === 'Uscita') acc.u++;
        return acc;
    }, {a:0, r:0, u:0});

    if(document.getElementById('stat-assenze')) document.getElementById('stat-assenze').innerText = counts.a;
    if(document.getElementById('stat-ritardi')) document.getElementById('stat-ritardi').innerText = counts.r;
    if(document.getElementById('stat-uscite')) document.getElementById('stat-uscite').innerText = counts.u;

    const justCont = document.getElementById('home-justifications-scroll');
    if(justCont) {
        const pending = attendanceEvents.filter(e => !e.justified);
        justCont.innerHTML = pending.map(j => `
            <div class="scroll-card just-card">
                <div class="card-meta-row"><div class="mini-icon i-red">🚩</div><span class="prio-tag p-high">Azione</span></div>
                <p class="task-title">${j.type} (${j.hours || '-'}): ${j.reason || 'Nessuna nota'}</p>
                <div class="diario-card-footer"><span>📅 ${j.date}</span><button class="btn-primary" style="padding:4px 8px; font-size:10px;" onclick="justifyEvent(${j.id})">Giustifica</button></div>
            </div>
        `).join('') || '<p class="empty-placeholder">Nulla da giustificare.</p>';
    }

    const hwCont = document.getElementById('home-homework-scroll');
    if(hwCont) {
        hwCont.innerHTML = homeworkTasks.map(t => `<div class="scroll-card"><div class="card-meta-row"><div class="mini-icon i-blue">📝</div><span class="subj-tag">${t.subject}</span></div><p class="task-title">${t.title}</p><div class="diario-card-footer"><span>📅 ${t.expiry}</span></div></div>`).join('') || '<p class="empty-placeholder">Nessun compito.</p>';
    }

    const evCont = document.getElementById('home-events-scroll');
    if(evCont) {
        evCont.innerHTML = systemEvents.map(e => `<div class="scroll-card event-card"><div class="card-meta-row"><div class="mini-icon i-teal">🗓️</div><span class="subj-tag">${e.category}</span></div><p class="task-title">${e.title}</p><div class="diario-card-footer"><span>📅 ${e.date}</span></div></div>`).join('') || '<p class="empty-placeholder">Nessun evento.</p>';
    }

    const gradesCont = document.getElementById('home-grades-scroll');
    if(gradesCont) {
        let allGrades = [];
        schoolData.forEach(sub => (sub.grades || []).forEach(g => allGrades.push({...g, subjectName: sub.name})));
        allGrades.sort((a,b) => new Date(b.date) - new Date(a.date));
        gradesCont.innerHTML = allGrades.slice(0, 6).map(g => `
            <div class="scroll-card">
                <div class="card-meta-row"><div class="mini-icon i-gold">🌟</div><strong style="color:var(--text-main);">${g.subjectName}</strong>
                <div class="grade-bubble ${
                    !isNaN(parseFloat(g.value)) 
                        ? (parseFloat(g.value) >= 6 ? 'g-green' : 'g-red') 
                        : (g.value === '+' ? 'g-green' : (g.value === '-' ? 'g-red' : 'g-grey'))
                }">${formatGradeDisplay(g.value)}</div>
                </div>
                <p style="font-size:11px; margin-top:8px;">${g.desc}</p>
            </div>
        `).join('') || '<p class="empty-placeholder">Nessun voto.</p>';
    }

    const remCont = document.getElementById('home-reminders-scroll');
    if(remCont) {
        remCont.innerHTML = reminderTasks.map(r => `<div class="scroll-card"><div class="card-meta-row"><div class="mini-icon i-purple">🔔</div><span class="rem-type-tag">${r.type}</span></div><p class="task-title">${r.title}</p><div class="diario-card-footer"><span>📅 ${r.date}</span></div></div>`).join('') || '<p class="empty-placeholder">Nessuna prova.</p>';
    }
}
function renderDiarioSection() {
    const container = document.getElementById('diario-cards-hook');
    if(!container) return;

    let filteredTasks = homeworkTasks;
    const titleLabel = document.getElementById('diario-title-label');

    if (currentDiarioView === 'giorno') {
        filteredTasks = homeworkTasks.filter(t => t.expiry === selectedDiarioDate);
        if (titleLabel) titleLabel.innerText = `Compiti per il ${new Date(selectedDiarioDate).toLocaleDateString('it-IT')}`;
    } else if (currentDiarioView === 'settimana') {
        const now = new Date();
        const inAWeek = new Date();
        inAWeek.setDate(now.getDate() + 7);
        filteredTasks = homeworkTasks.filter(t => {
            const d = new Date(t.expiry);
            return d >= now && d <= inAWeek;
        });
        if (titleLabel) titleLabel.innerText = "Compiti della Prossima Settimana";
    } else {
        if (titleLabel) titleLabel.innerText = "Tutti i Compiti Ordinati";
        filteredTasks = [...homeworkTasks].sort((a,b) => new Date(a.expiry) - new Date(b.expiry));
    }

    if(document.getElementById('homework-counter-badge')) 
        document.getElementById('homework-counter-badge').innerText = `${filteredTasks.length} Compiti`;

    const now = new Date();
    container.innerHTML = filteredTasks.map(t => {
        const expiryDate = parseDateSafe(t.expiry);
        const isUrgent = (expiryDate.getTime() - now.getTime()) <= 86400000;
        const urgentClass = isUrgent ? 'urgent-red' : '';
        
        return `<div class="diario-card ${urgentClass}"><div class="card-prio-indicator ${t.priority === 'Alta' ? 'p-high' : 'p-med'}"></div><div class="diario-card-body"><span class="subj-tag">${t.subject}</span><p class="task-title">${t.title}</p><div class="diario-card-footer"><span>📅 ${t.expiry}</span> <button class="btn-delete-task" onclick="removeHomework(${t.id})">Elimina</button></div></div></div>`;
    }).join('') || `<p class="empty-placeholder">Nessun compito per ${currentDiarioView === 'giorno' ? 'questo giorno' : 'questo periodo'}.</p>`;
}

function renderWeeklyCalendar() {
    const hook = document.getElementById('weekly-calendar-hook');
    if (!hook) return;

    if (!calendarReferenceDate) {
        const today = new Date();
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1); 
        calendarReferenceDate = new Date(today.setDate(diff));
        calendarReferenceDate.setHours(0,0,0,0);
    }

    const monday = new Date(calendarReferenceDate);

    // Aggiorna il label del mese/anno
    const label = document.getElementById('calendar-month-year-label');
    if (label) {
        label.innerText = monday.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    }

    let html = '';
    const dayNames = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const isoDate = d.toISOString().split('T')[0];
        const dayNum = d.getDate();
        const dayName = dayNames[i];
        const isActive = isoDate === selectedDiarioDate;

        const hasTasks = homeworkTasks.some(t => t.expiry === isoDate) || 
                         reminderTasks.some(r => r.date === isoDate);

        html += `
            <div class="calendar-day-item ${isActive ? 'active' : ''}" onclick="selectDiarioDate('${isoDate}')">
                <span class="cal-day-name">${dayName}</span>
                <span class="cal-day-num">${dayNum}</span>
                ${hasTasks ? '<div class="task-dot"></div>' : ''}
            </div>
        `;
    }
    hook.innerHTML = html;
}

function moveWeek(offset) {
    if (!calendarReferenceDate) return;
    calendarReferenceDate.setDate(calendarReferenceDate.getDate() + (offset * 7));
    renderWeeklyCalendar();
}

function selectDiarioDate(isoDate) {
    selectedDiarioDate = isoDate;
    currentDiarioView = 'giorno'; 
    document.querySelectorAll('#tab-diario .segment-btn').forEach(b => b.classList.remove('active'));
    const btnGiorno = document.getElementById('view-giorno');
    if (btnGiorno) btnGiorno.classList.add('active');
    
    renderWeeklyCalendar();
    renderDiarioSection();
}

function renderRemindersSection() {
    const container = document.getElementById('reminders-cards-hook');
    if(!container) return;
    container.innerHTML = reminderTasks.map(r => `
        <div class="diario-card">
            <div class="card-prio-indicator p-high"></div>
            <div class="diario-card-body">
                <div class="card-meta-row">
                    <div>
                        <input type="checkbox" ${r.completed ? 'checked' : ''} onclick="toggleReminder(${r.id})" style="margin-right: 8px; cursor:pointer;">
                        <span class="rem-type-tag">${r.type}</span>
                    </div>
                    <span class="subj-tag">${r.subject}</span>
                </div>
                <p class="task-title ${r.completed ? 'completed' : ''}">${r.title}</p>
                <div class="diario-card-footer">
                    <span> ${r.date}</span>
                    <button class="btn-delete-task" onclick="removeReminder(${r.id})">Elimina</button>
                </div>
            </div>
        </div>
    `).join('') || '<p class="empty-placeholder">Nessun promemoria.</p>';
}

function renderEventsSection() {
    const container = document.getElementById('events-management-hook');
    if(!container) return;
    container.innerHTML = systemEvents.map(e => `<div class="diario-card"><div class="diario-card-body"><span class="subj-tag">${e.category}</span><p class="task-title">${e.title}</p><div class="diario-card-footer"><span>📅 ${e.date}</span><button class="btn-delete-task" onclick="removeEvent(${e.id})">Elimina</button></div></div></div>`).join('') || '<p class="empty-placeholder">Nessun evento.</p>';
}

function renderAppelloSection() {
    const container = document.getElementById('attendance-list-hook');
    if(!container) return;
    container.innerHTML = attendanceEvents.map(e => `
        <div class="diario-card">
            <div class="card-prio-indicator ${e.justified ? 'p-low' : 'p-high'}"></div>
            <div class="diario-card-body">
                <div class="card-meta-row"><b>${e.type}</b> <span>${e.hours ? '🕒 ' + e.hours : ''} ${e.justified ? '✅' : ''}</span></div>
                <p class="task-title">${e.reason || 'Nessuna nota'}</p>
                <div class="diario-card-footer"><span>📅 ${e.date}</span> <div>
                ${e.justified ? '' : `<button class="btn-primary" style="padding:4px 8px; font-size:10px;" onclick="justifyEvent(${e.id})">Giustifica</button>`}
                <button class="btn-delete-task" onclick="removeAttendance(${e.id})">Elimina</button></div></div>
            </div>
        </div>
    `).join('') || '<p class="empty-placeholder">Nessun evento registrato.</p>';
}

function renderScrutinioTable() {
    const hook = document.getElementById('scrutinio-tbody-hook');
    if(!hook) return;
    hook.innerHTML = schoolData.length ? schoolData.map(s => {
        const voto = s.scrutinio[currentScrutinioPeriod].voto;
        let colorClass = 'g-grey';
        if (voto !== '-') {
            const v = parseFloat(voto);
            if (v >= 6) colorClass = 'g-green';
            else colorClass = 'g-red';
        }
        return `
        <tr>
            <td class="bold-text-blue">${s.name}</td>
            <td class="text-center">${s.scrutinio[currentScrutinioPeriod].assenze}</td>
            <td class="text-center"><span class="scrutinio-pill-box ${colorClass}">${formatGradeDisplay(voto)}</span></td>
            <td class="text-right"><button class="btn-edit-scrutinio" onclick="launchScrutinioModal(${s.id})">Modifica</button></td>
        </tr>
    `}).join('') : '<tr><td colspan="4" class="text-center">Nessuna materia registrata</td></tr>';
}

function getFileIcon(type) {
    if (!type) return '📄';
    const t = type.toLowerCase();
    if (t.includes('pdf')) return '📕';
    if (t.includes('word') || t.includes('msword') || t.includes('officedocument.wordprocessingml')) return '📘';
    if (t.includes('image')) return '🖼️';
    if (t.includes('presentation') || t.includes('powerpoint') || t.includes('officedocument.presentationml')) return '📙';
    if (t.includes('sheet') || t.includes('excel') || t.includes('officedocument.spreadsheetml')) return '📗';
    if (t.includes('zip') || t.includes('rar') || t.includes('compressed')) return '📦';
    return '📄';
}

function getFriendlyTypeName(type) {
    if (!type) return "FILE";
    if (type.includes('/')) return type.split('/')[1].toUpperCase();
    if (type.includes('.')) return type.split('.').pop().toUpperCase();
    return type.toUpperCase();
}

function renderCondivisione() {
    const container = document.getElementById('condivisione-list-hook');
    if (!container) return;
    
    container.innerHTML = schoolData.map(sub => {
        const materials = (window.subjectMaterials || []).filter(m => m.subjectId === sub.id);
        return `
            <div class="premium-card margin-top-20">
                <div class="flex-row-justify">
                    <h3 style="color: ${sub.color}">${sub.name}</h3>
                    <button class="btn-primary teal-btn" onclick="openUploadModal(${sub.id})">＋ Aggiungi</button>
                </div>
                <div class="margin-top-15">
                    ${materials.length ? materials.map(m => `
                        <div class="detail-grade-row" style="background: var(--argo-body-bg); margin-bottom: 8px;">
                            <div class="icon-emoji" style="cursor:pointer" onclick="downloadMaterial(${m.id})">${getFileIcon(m.type)}</div>
                            <div class="grade-info-block" style="cursor:pointer; flex:1;" onclick="downloadMaterial(${m.id})">
                                <span style="font-size: 13px;">${m.name}</span>
                                <small>${m.date} • ${getFriendlyTypeName(m.type)}</small>
                            </div>
                            <div class="grade-actions">
                                <button class="btn-inline-del" onclick="downloadMaterial(${m.id})" style="color: var(--argo-blue-text); margin-right: 10px;" title="Apri/Scarica">💾</button>
                                <button class="btn-inline-del" onclick="removeMaterial(${m.id})">🗑️</button>
                            </div>
                        </div>
                    `).join('') : '<p class="empty-placeholder">Nessun file presente.</p>'}
                </div>
            </div>
        `;
    }).join('') || '<p class="empty-placeholder">Configura le materie per iniziare a caricare file.</p>';
}

function openUploadModal(subId) {
    document.getElementById('upload-subject-id').value = subId;
    openModal('sharing-upload-modal');
}

function commitMaterialUpload() {
    const subId = parseInt(document.getElementById('upload-subject-id').value);
    const fileInput = document.getElementById('sharing-file-input');
    if (!fileInput.files.length) return showToast("Seleziona un file", "error");
    
    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
        const material = {
            id: Date.now(),
            subjectId: subId,
            name: file.name,
            type: file.type || "Documento",
            date: new Date().toLocaleDateString('it-IT'),
            data: e.target.result // Salviamo il contenuto reale del file
        };
        
        if(!window.subjectMaterials) window.subjectMaterials = [];
        window.subjectMaterials.push(material);
        updateStorage('myDidupMaterialsDesktop', window.subjectMaterials);
        
        fileInput.value = "";
        closeModal('sharing-upload-modal');
        showToast("File caricato con successo!");
        renderCondivisione();
    };

    reader.onerror = () => showToast("Errore nel caricamento del file", "error");
    reader.readAsDataURL(file); // Legge il file per poterlo salvare
}

function downloadMaterial(id) {
    const m = window.subjectMaterials.find(x => x.id === id);
    if (!m || !m.data) return showToast("File non trovato o dati mancanti", "error");

    const link = document.createElement('a');
    link.href = m.data;
    link.download = m.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Download avviato...");
}

function removeMaterial(id) {
    if(confirm("Vuoi eliminare questo file?")) {
        window.subjectMaterials = window.subjectMaterials.filter(m => m.id !== id);
        updateStorage('myDidupMaterialsDesktop', window.subjectMaterials);
        renderCondivisione();
    }
}

function renderSubjectsAccordion() {
    const container = document.getElementById('desktop-subjects-accordion-container');
    if (!container) return;
    container.innerHTML = '';

    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
        const avg = totalWeight > 0 ? (weightedSum / totalWeight).toFixed(2) : '--';
        const lastGrade = fGrades.length > 0 ? fGrades[fGrades.length - 1].value : '-';
        
        let avgColor = "#94a3b8"; // grigio
        if(avg !== '--') {
            avgColor = avg >= 6 ? "#10b981" : (avg >= 5 ? "#f59e0b" : "#ef4444");
        }

        container.innerHTML += `
            <div class="subject-list-item" onclick="openSubjectDetail(${sub.id})">
                <div class="avg-circle-small" style="background-color: ${avgColor}">${avg}</div>
                <div class="subject-info-main">
                    <div class="sub-title-row editable-subject-name-wrapper">
                        <span id="subject-name-display-${sub.id}">${sub.name}</span>
                        <button class="edit-subject-btn" onclick="event.stopPropagation(); enableSubjectNameEdit(${sub.id}, 'subject-name-display-${sub.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                    </div>
                    <div class="sub-meta-row">Ultimo voto: <b>${formatGradeDisplay(lastGrade)}</b> | Totale voti: <b>${fGrades.length}</b></div>
                </div>
                <div class="arrow-icon">❯</div>
            </div>
        `;
    });
}

function openSubjectDetail(subId) {
    const sub = schoolData.find(s => s.id === subId);
    if(!sub) return;
    currentSubjectDetailId = subId;
    
    const fGrades = filterGradesByPeriod(sub.grades || []);

    // Elementi del dettaglio materia con controllo di esistenza
    const nameDisplayEl = document.getElementById('detail-sub-name-display');
    if (nameDisplayEl) nameDisplayEl.innerText = sub.name;

    const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
    const avg = totalWeight > 0 ? (weightedSum / totalWeight).toFixed(2) : '--';
    const avgEl = document.getElementById('detail-subject-avg');
    if (avgEl) avgEl.innerText = `Media Generale: ${avg}`;

    // Calcolo medie specifiche
    const typeAvgs = calculateTypeAverages(fGrades);
    if (document.getElementById('avg-scritti')) document.getElementById('avg-scritti').innerText = typeAvgs.scritto;
    if (document.getElementById('avg-orali')) document.getElementById('avg-orali').innerText = typeAvgs.orale;
    if (document.getElementById('avg-pratici')) document.getElementById('avg-pratici').innerText = typeAvgs.pratico;

    // Lista Voti con nuovo stile
    const listCont = document.getElementById('detail-grades-list');
    if (listCont) {
        listCont.innerHTML = fGrades.map(g => {
            const num = parseFloat(g.value);
            let colorClass = "g-grey";
            if (!isNaN(num)) {
                colorClass = num >= 6 ? "g-green" : (num >= 5 ? "g-orange" : "g-red");
            } else if (g.value === '+') {
                colorClass = "g-green";
            } else if (g.value === '-') {
                colorClass = "g-red";
            }
            return `
                <div class="detail-grade-row" onclick="openGradeDetailView(${sub.id}, ${g.id})">
                    <div class="grade-circle-detail ${colorClass}">${formatGradeDisplay(g.value)}</div>
                    <div class="grade-info-block">
                        <span>${new Date(g.date).toLocaleDateString('it-IT')}</span>
                        <small>${g.type} • ${g.desc}</small>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="grade-actions">
                            <button class="btn-inline-del" onclick="event.stopPropagation(); launchEditGradeModal(${sub.id}, ${g.id})" style="color: var(--argo-blue-text)">✏️</button>
                            <button class="btn-inline-del" onclick="event.stopPropagation(); deleteGrade(${sub.id}, ${g.id})">🗑️</button>
                        </div>
                        <span style="color:var(--text-sub); font-weight:bold; margin-left:5px;">❯</span>
                    </div>
                </div>
            `;
        }).join('') || '<p class="empty-placeholder">Nessun voto in questo periodo.</p>';
    }

    openModal('subject-detail-modal');
    // Disegna grafico specifico materia
    renderSubjectLineChart(subId, fGrades);
    renderSubjectGradeDistributionBarChart(subId, fGrades);

    // Ripristina la visualizzazione della simulazione se presente
    if (simulatedValues[subId]) {
        updatePredictionUI(subId);
    } else {
        document.getElementById('prediction-info-box').style.display = 'none';
    }
}

/**
 * Apre la vista dettagliata di un singolo voto (Stile Registro Elettronico)
 */
function openGradeDetailView(subId, gradeId) {
    const sub = schoolData.find(s => s.id === subId);
    if (!sub) return;
    const grade = sub.grades.find(g => g.id === gradeId);
    if (!grade) return;

    // Cerca il docente nell'orario per questa materia
    let teacherName = sub.name;
    for (let key in schoolTimetable) {
        if (schoolTimetable[key].subject === sub.name && schoolTimetable[key].teacher) {
            teacherName = schoolTimetable[key].teacher;
            break;
        }
    }

    // Popolamento dinamico del modale
    document.getElementById('gd-teacher-name').innerText = teacherName;
    document.getElementById('gd-date').innerText = new Date(grade.date).toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('gd-subject').innerText = sub.name;
    document.getElementById('gd-type').innerText = `Tipologia prova: ${grade.type}`;
    document.getElementById('gd-value-text').innerText = `Valore del voto: ${grade.value}`;
    document.getElementById('gd-weight').innerText = `Peso sulla media: ${grade.weight || 100}%`;

    // Card del voto (bubble)
    const bubble = document.getElementById('gd-bubble');
    bubble.innerText = grade.value;
    const num = parseFloat(grade.value);
    let color = "#94a3b8"; // Default
    if (!isNaN(num)) color = num >= 6 ? "var(--argo-teal)" : (num >= 5 ? "var(--warning-bg)" : "var(--urgent-bg)");
    else if (grade.value === '+') color = "var(--argo-teal)";
    else if (grade.value === '-') color = "var(--urgent-bg)";
    bubble.style.backgroundColor = color;

    // Descrizione e Commento separati
    document.getElementById('gd-description-text').innerText = grade.desc || "Descrizione non disponibile";
    document.getElementById('gd-comment-text').innerText = grade.comment || "Commento non disponibile";

    // Salvataggio riferimenti per la condivisione
    window.currentGradeDetail = { sub, grade };

    openModal('grade-detail-view-modal');
}

/**
 * Condivide i dettagli del voto su WhatsApp tramite messaggio formattato
 */
function shareGradeOnWhatsApp() {
    if (!window.currentGradeDetail) return;
    const { sub, grade } = window.currentGradeDetail;
    const date = new Date(grade.date).toLocaleDateString('it-IT');
    
    const text = `🎒 *Nuovo Voto su didUP*%0A%0A` +
                 `📚 *Materia:* ${sub.name}%0A` +
                 `⭐ *Voto:* ${grade.value}%0A` +
                 `📅 *Data:* ${date}%0A` +
                 `📝 *Tipo:* ${grade.type}%0A` +
                 `⚖️ *Peso:* ${grade.weight || 100}%%0A` +
                 `📖 *Argomento:* ${grade.desc || 'N.D.'}%0A` +
                 `💬 *Commento:* ${grade.comment || 'N.D.'}`;
                 
    window.open(`https://wa.me/?text=${text}`, '_blank');
}

function calculateTypeAverages(grades) {
    const types = { 'Scritto': [], 'Orale': [], 'Pratico': [] };
    grades.forEach(g => {
        if(types[g.type]) types[g.type].push(g.value);
        else if(g.type === 'Grafico') types['Pratico'].push(g.value);
    });
    
    const getAvg = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : '--';
    return { scritto: getAvg(types.Scritto), orale: getAvg(types.Orale), pratico: getAvg(types.Pratico) };
}

// Plugin per la linea verticale che segue il mouse nei grafici
const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw: (chart) => {
        if (chart.tooltip?._active?.length) {
            const activePoint = chart.tooltip._active[0];
            const { ctx } = chart;
            const { x } = activePoint.element;
            const topY = chart.scales.y.top;
            const bottomY = chart.scales.y.bottom;

            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([5, 5]); // Linea tratteggiata stile iOS
            ctx.moveTo(x, topY);
            ctx.lineTo(x, bottomY);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = 'rgba(142, 142, 147, 0.5)'; // Colore neutro semi-trasparente
            ctx.stroke();
            ctx.restore();
        }
    }
};

function renderSubjectLineChart(subId, grades) {
    const canvas = document.getElementById('single-subject-chart-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (subjectChartInstance) subjectChartInstance.destroy();

    // Filtra solo i voti numerici per il grafico
    const numericGrades = grades.filter(g => !isNaN(parseFloat(g.value)));

    if (numericGrades.length < 2) {
        const parent = canvas.parentElement;
        if(parent) parent.innerHTML = '<canvas id="single-subject-chart-canvas"></canvas><div class="empty-placeholder" style="padding:20px;">Dati insufficienti per il grafico</div>';
        return;
    }

    // Ordina i voti per data per il grafico
    const sortedGrades = [...numericGrades].sort((a, b) => new Date(a.date) - new Date(b.date));
    const labels = sortedGrades.map(g => new Date(g.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }));
    const dataValues = sortedGrades.map(g => parseFloat(g.value));

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--argo-blue-text').trim() || '#007AFF';
    const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--argo-teal').trim() || '#34C759';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';

    // Gradiente vibrante per la materia
    const fillGradient = ctx.createLinearGradient(0, 0, 0, 180); // Aggiunto per coerenza
    const startColor = primaryColor.includes('rgb') ? primaryColor.replace('rgb', 'rgba').replace(')', ', 0.3)') : primaryColor + '4D';
    const endColor = 'rgba(255, 255, 255, 0)';

    fillGradient.addColorStop(0, startColor);
    fillGradient.addColorStop(1, endColor);

    subjectChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                borderColor: 'var(--primary-orange)',
                backgroundColor: fillGradient,
                fill: true, // Aggiunto per coerenza
                tension: 0.4,
                borderWidth: 4,
                pointRadius: 5,
                pointBackgroundColor: '#FFFFFF',
                pointBorderColor: primaryColor,
                pointBorderWidth: 3,
                pointHoverRadius: 9
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: { 
                legend: { display: false },
                tooltip: {
                    enabled: true, // Aggiunto per coerenza
                    backgroundColor: 'var(--primary-orange)',
                    titleFont: { family: 'Inter', weight: 'bold' },
                    bodyFont: { family: 'Inter', weight: 'bold' },
                    padding: 12,
                    cornerRadius: 10,
                    displayColors: false,
                    callbacks: {
                        label: (context) => `Voto: ${context.parsed.y}`
                    }
                }
            },
            scales: {
                y: { min: 2, max: 10, ticks: { stepSize: 1, color: textColor }, grid: { color: gridColor } },
                x: { ticks: { color: textColor }, grid: { color: gridColor } }
            }
        },
        plugins: [verticalLinePlugin]
    });
}

function renderStudyHistoryChart() {
    const canvas = document.getElementById('study-history-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (window.studyHistoryChartInstance) window.studyHistoryChartInstance.destroy();

    // Metrica: Conteggio promemoria completati e compiti presenti per gli ultimi 7 giorni
    const last7Days = [...Array(7)].map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toISOString().split('T')[0];
    }).reverse();

    const data = last7Days.map(date => {
        const tasks = homeworkTasks.filter(t => t.expiry === date).length;
        const rems = reminderTasks.filter(r => r.date === date && r.completed).length;
        return tasks + rems;
    });

    window.studyHistoryChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['6gg fa', '5gg fa', '4gg fa', '3gg fa', '2gg fa', 'Ieri', 'Oggi'],
            datasets: [{ label: 'Attività', data: data, backgroundColor: '#34C759' }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

function calculateGradeDistribution(period) {
    const gradeCounts = {};
    for (let i = 1; i <= 10; i++) {
        gradeCounts[i] = 0;
    }

    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || [], period);
        fGrades.forEach(g => {
            const val = parseFloat(g.value);
            if (!isNaN(val) && val >= 1 && val <= 10) {
                const roundedGrade = Math.round(val);
                gradeCounts[roundedGrade]++;
            }
        });
    });
    return gradeCounts;
}

function renderGradeDistributionBarChart(gradeCounts) {
    const canvas = document.getElementById('grade-distribution-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (gradeDistributionChartInstance) gradeDistributionChartInstance.destroy();

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    const labels = Object.keys(gradeCounts);
    const dataValues = Object.values(gradeCounts);

    const backgroundColors = labels.map(grade => {
        const g = parseInt(grade);
        if (g >= 6) return '#34C759'; // Verde
        if (g >= 5) return '#FF9500'; // Arancio
        return '#FF3B30'; // Rosso
    });

    gradeDistributionChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                backgroundColor: backgroundColors,
                borderColor: backgroundColors,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } },
                x: { ticks: { color: textColor }, grid: { display: false } }
            }
        },
        plugins: [verticalLinePlugin] // Manteniamo il plugin della linea verticale anche qui
    });
}

function calculateSingleSubjectGradeDistribution(grades) {
    const gradeCounts = {};
    for (let i = 1; i <= 10; i++) gradeCounts[i] = 0;
    
    grades.forEach(g => {
        const val = parseFloat(g.value);
        if (!isNaN(val) && val >= 1 && val <= 10) {
            const roundedGrade = Math.round(val);
            gradeCounts[roundedGrade]++;
        }
    });
    return gradeCounts;
}

function renderSubjectGradeDistributionBarChart(subId, grades) {
    const canvas = document.getElementById('subject-grade-distribution-chart-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (subjectGradeDistributionChartInstance) subjectGradeDistributionChartInstance.destroy();

    const gradeCounts = calculateSingleSubjectGradeDistribution(grades);
    const labels = Object.keys(gradeCounts);
    const dataValues = Object.values(gradeCounts);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    const backgroundColors = labels.map(grade => { // Aggiunto per coerenza
        const g = parseInt(grade);
        if (g >= 6) return '#34C759'; 
        if (g >= 5) return '#FF9500';
        return '#FF3B30';
    });

    subjectGradeDistributionChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                backgroundColor: backgroundColors,
                borderColor: backgroundColors,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                y: { 
                    beginAtZero: true, 
                    ticks: { color: textColor, precision: 0 }, // Aggiunto per coerenza
                    grid: { color: gridColor } 
                },
                x: { ticks: { color: textColor }, grid: { display: false } }
            }
        }
    });
}

function populateSubjectSelects() {
    const ids = ['hw-subject-select', 'rem-subject-select', 'grade-subject-select', 'tt-subject-select'];
    ids.forEach(id => {
        const sel = document.getElementById(id);
        if(!sel) return;
        if (id === 'grade-subject-select') {
            sel.innerHTML = schoolData.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
            if (schoolData.length > 0) {
                sel.value = schoolData[0].id; // Select the first subject by default
            } else {
                sel.innerHTML = '<option value="">Nessuna materia disponibile</option>';
            }
        } else if (id === 'tt-subject-select') {
            sel.innerHTML = schoolData.map(s => `<option value="${s.name}">${s.name}</option>`).join('') + '<option value="Altro">Altro / Libero</option>';
        } else {
            sel.innerHTML = schoolData.length ? schoolData.map(s => `<option value="${s.name}">${s.name}</option>`).join('') : '<option value="">Crea prima una materia</option>';
        }
    });
}

function populateTimetableSelects() {
    const sel = document.getElementById('tt-subject-select');
    if(!sel) return;
    sel.innerHTML = schoolData.map(s => `<option value="${s.name}">${s.name}</option>`).join('') + '<option value="Altro">Altro / Libero</option>';
}

function renderAttendancePieChart() {
    const chart = document.getElementById('attendance-pie-chart');
    if(!chart) return;
    
    const totalHoursAbs = attendanceEvents
        .filter(e => e.type === 'Assenza')
        .reduce((sum, e) => sum + (parseFloat(e.hours) || 0), 0);
    
    const maxHours = 206 * 6;
    const perc = ((totalHoursAbs / maxHours) * 100).toFixed(1);
    
    chart.style.setProperty('--p-perc', (100 - perc) + '%');
    if(document.getElementById('total-hours-abs')) document.getElementById('total-hours-abs').innerText = totalHoursAbs;
    const pAbs = document.getElementById('perc-assenze'); if(pAbs) pAbs.innerText = perc;
    const pPre = document.getElementById('perc-presenze'); if(pPre) pPre.innerText = (100-perc).toFixed(1);
}
function renderTargetAnalysis(currentAvg) {
    const hook = document.getElementById('target-analysis-hook');
    if (!hook) return;

    // Ottieni il valore dell'obiettivo dalla UI
    const targetInput = document.getElementById('target-avg-input');
    const targetValue = targetInput ? targetInput.value : "";

    if (!targetValue) {
        hook.innerHTML = '<p class="empty-placeholder" style="padding: 10px 0; margin: 0;">Imposta un obiettivo per vedere l\'analisi.</p>';
        return;
    }
    
    const target = parseFloat(targetValue);
    if (isNaN(target)) {
        hook.innerHTML = '<p style="text-align:center; color:var(--text-sub); font-size:10px;">Inserisci target per calcolare i voti necessari.</p>';
        return;
    }

    localStorage.setItem('myDidupTargetAvg', targetValue);

    let html = `<div style="font-weight:700; margin-bottom:10px; color:var(--text-main); border-bottom:1px solid var(--border-color); padding-bottom:5px;">Analisi Obiettivo ${target.toFixed(2)}</div>`;

    // Usa la media passata dalla dashboard (Media delle Medie) per coerenza
    const overallIndividualAvg = currentAvg;

    // Conta quante materie hanno voti per il calcolo del delta
    const subjectsWithGrades = schoolData.filter(s => filterGradesByPeriod(s.grades || []).length > 0);
    const n = subjectsWithGrades.length;

    if (n > 0 && overallIndividualAvg < target) {
        // In una media di medie, per alzare la media globale di 'diff', 
        // devi alzare la media di UNA materia di 'diff * n'
        const diffNeeded = target - overallIndividualAvg;
        const totalGainNeeded = diffNeeded * n;

        // Troviamo la materia "più facile" da alzare (quella con meno voti)
        const easiestSubject = subjectsWithGrades.reduce((prev, curr) => 
            filterGradesByPeriod(prev.grades).length <= filterGradesByPeriod(curr.grades).length ? prev : curr
        );

        const fGrades = filterGradesByPeriod(easiestSubject.grades);
        const currentSubSum = fGrades.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
        const currentSubCount = fGrades.length;
        const neededGrade = ((overallIndividualAvg + diffNeeded) * (currentSubCount + 1)) - currentSubSum; 
        // Nota: approssimazione semplificata per il feedback rapido
        
        html += `<div class="target-advice-item" style="margin-bottom:15px; background:var(--argo-blue-text); color:white; padding:8px; border-radius:8px;">
                    <span>Prossimo traguardo:</span> <b>${target.toFixed(2)}</b></div>`;
    } else if (overallIndividualAvg >= target && n > 0) {
        html += `<div style="color:var(--argo-teal); font-weight:700; margin-bottom:15px;">✨ Media generale raggiunta!</div>`;
    }

    // Elenco di tutte le materie
    html += `<div style="font-weight:700; margin-top:5px; margin-bottom:8px; font-size:11px; color:var(--text-muted); text-transform:uppercase;">Dettaglio per materia:</div>`;
    
    schoolData.forEach(s => {
        const fGrades = filterGradesByPeriod(s.grades || []);
        const unweightedSum = fGrades.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
        const unweightedCount = fGrades.filter(g => !isNaN(parseFloat(g.value))).length;
        const currentAvg = unweightedCount > 0 ? unweightedSum / unweightedCount : 0;

        let advice = "";
        if (unweightedCount === 0) {
            advice = `<span style="color:var(--text-sub)">Mancano voti</span>`;
        } else if (currentAvg >= target) {
            advice = `<span style="color:var(--argo-teal)">Target OK</span>`;
        } else {
            let nextGrade = (target * (unweightedCount + 1)) - unweightedSum;
            if (nextGrade <= 10) {
                advice = `Serve un <b>${nextGrade <= 1 ? 'qualsiasi voto' : nextGrade.toFixed(1)}</b>`;
            } else {
                // Calcolo quanti 10 servono: (Sum + 10k) / (Count + k) = Target  => k = (Target*Count - Sum) / (10 - Target)
                let k = (target * unweightedCount - unweightedSum) / (10 - target);
                advice = `Servono <b>${Math.ceil(k)}</b> voti da <b>10</b>`;
            }
        }

        html += `
            <div class="target-advice-item" style="padding: 4px 0; border-bottom: 1px solid var(--border-color); font-size: 11px;">
                <span style="max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.name}</span>
                <span>${advice}</span>
            </div>`;
    });

    html += `<button class="btn-primary" style="width:100%; margin-top:12px; font-size:10px; padding:8px;" onclick="openTargetAnalysisModal()">Espandi Analisi Completa</button>`;

    hook.innerHTML = html;
}

/**
 * Apre il modale dedicato all'analisi approfondita dell'obiettivo.
 */
function openTargetAnalysisModal() {
    const targetValue = localStorage.getItem('myDidupTargetAvg') || "6.0";
    const target = parseFloat(targetValue);
    
    // Se il modale non esiste nell'HTML, lo iniettiamo nel DOM dinamicamente
    if (!document.getElementById('target-analysis-modal')) {
        const modalHtml = `
            <div id="target-analysis-modal" class="modal">
                <div class="modal-content modal-content-large" style="width: 700px;">
                    <div class="modal-header">
                        <h3>🎯 Analisi Obiettivo Personale</h3>
                        <button class="close-btn" onclick="closeModal('target-analysis-modal')">×</button>
                    </div>
                    <div class="modal-body" id="target-analysis-modal-body"></div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        initSwipeToClose(); // Attiva il trascinamento per chiudere su mobile
    }

    renderTargetAnalysisModalContent(target);
    openModal('target-analysis-modal');
}

/**
 * Renderizza il contenuto del modale Analisi Obiettivo con design "in grande".
 */
function renderTargetAnalysisModalContent(target) {
    const hook = document.getElementById('target-analysis-modal-body');
    if (!hook) return;

    // Ricalcolo esatto della media delle medie per il modale
    let grandTotal = 0, grandCount = 0;
    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
        if (totalWeight > 0) {
            grandTotal += (weightedSum / totalWeight);
            grandCount++;
        }
    });
    const currentAvg = grandCount > 0 ? grandTotal / grandCount : 0;

    let html = `
        <div class="target-modal-hero">
            <div class="target-hero-stat">
                <h6>Il Tuo Obiettivo</h6>
                <div class="target-val">${target.toFixed(1)}</div>
            </div>
            <div class="target-hero-divider"></div>
            <div class="target-hero-stat">
                <h6>Media Attuale</h6> 
                <div class="target-val" style="color: ${currentAvg >= target ? 'var(--argo-teal)' : 'var(--urgent-bg)'}">${currentAvg.toFixed(2)}</div>
            </div>
        </div>
    `;

    if (grandCount > 0 && currentAvg < target) {
        // Troviamo la materia con meno voti (più facile da influenzare) per dare un consiglio concreto
        const subjectsWithGrades = schoolData.filter(s => filterGradesByPeriod(s.grades || []).length > 0);
        const easiestSubject = subjectsWithGrades.reduce((prev, curr) => 
            filterGradesByPeriod(prev.grades).length <= filterGradesByPeriod(curr.grades).length ? prev : curr
        );
        const fGrades = filterGradesByPeriod(easiestSubject.grades);
        const currentSubSum = fGrades.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
        const currentSubCount = fGrades.length;

        const diff = target - currentAvg;
        const totalPointsNeeded = diff * grandCount;
        const next = ((currentSubSum / currentSubCount + totalPointsNeeded) * (currentSubCount + 1)) - currentSubSum;
        
        let advice = "";
        let color = "var(--argo-blue-text)";

        if (next > 10) {
            advice = `🎯 Obiettivo ambizioso! Ti servono diversi <b>10</b> per alzare la media globale a ${target.toFixed(1)}.`; // Aggiunto per coerenza
            color = "var(--urgent-bg)";
        } else if (next <= 1) {
            advice = "🚀 Sei vicinissimo! Basta un <b>qualsiasi voto</b> sopra l'1."; // Aggiunto per coerenza
            color = "var(--argo-teal)";
        } else {
            advice = `🎯 Ti basterebbe un <b>${next.toFixed(1)}</b> in <b>${easiestSubject.name}</b> per raggiungere l'obiettivo globale.`;
        }
        html += `<div class="target-main-advice" style="background:${color}">${advice}</div>`;
    } else if (grandCount > 0) {
        html += `<div class="target-main-advice" style="background:var(--argo-teal)">✨ Obiettivo raggiunto! Continua così.</div>`;
    } // Aggiunto per coerenza

    html += `<div class="target-grid-title">Dettaglio Voti Necessari per Materia</div>`;
    html += `<div class="target-subjects-grid">`;

    schoolData.forEach(s => {
        const fGrades = filterGradesByPeriod(s.grades || []);
        const unweightedSum = fGrades.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
        const unweightedCount = fGrades.filter(g => !isNaN(parseFloat(g.value))).length;
        const subAvg = unweightedCount > 0 ? unweightedSum / unweightedCount : 0;

        let subAdvice = "Dati assenti";
        let status = "none";

        if (unweightedCount > 0) {
            if (subAvg >= target) { subAdvice = "Target OK ✅"; status = "ok"; }
            else {
                let n = (target * (unweightedCount + 1)) - unweightedSum;
                if (n <= 10) { subAdvice = `Prendi <b>${n <= 1 ? 'voto > 1' : n.toFixed(1)}</b>`; status = "warning"; }
                else { subAdvice = `Servono <b>${Math.ceil((target * unweightedCount - unweightedSum) / (10 - target))}</b> x 10`; status = "urgent"; }
            }
        }
        html += `<div class="target-sub-card status-${status}"><div class="sub-name">${s.name}</div><div class="sub-advice">${subAdvice}</div></div>`;
    });

    html += `</div>`;
    hook.innerHTML = html;
}
function drawAreaChart(bucket, has) {
    const canvas = document.getElementById('main-grades-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Distruggi il grafico precedente se esiste per evitare sovrapposizioni
    if (mainChartInstance) mainChartInstance.destroy();

    if (!has) {
        const parent = canvas.parentElement;
        if(parent) parent.innerHTML = '<canvas id="main-grades-chart"></canvas><div class="empty-placeholder">Nessun dato per il grafico</div>';
        return;
    }

    // Rilevamento colori tema
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--argo-blue-text').trim() || '#007AFF';
    const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--argo-teal').trim() || '#34C759';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    // Creazione Gradiente Teal per il grafico generale
    const fillGradient = ctx.createLinearGradient(0, 0, 0, 250); // Aumentato l'altezza del gradiente per una sfumatura più ampia
    // Gradiente basato su #45B7AF (Teal)
    const startColor = 'rgba(69, 183, 175, 0.4)'; // #45B7AF con 40% di opacità
    const endColor = 'rgba(69, 183, 175, 0)';
    
    fillGradient.addColorStop(0, startColor);
    fillGradient.addColorStop(1, endColor);
    
    // Default font e stili per Chart.js
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = textColor;

    let activeMonths;
    if (currentPeriod === 'primo') activeMonths = [9, 10, 11, 12, 1];
    else if (currentPeriod === 'secondo') activeMonths = [2, 3, 4, 5];
    else activeMonths = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6];

    let labelMap = { 9: "SET", 10: "OTT", 11: "NOV", 12: "DIC", 1: "GEN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAG", 6: "GIU" };
    
    const labels = activeMonths.map(m => labelMap[m]);
    const dataValues = activeMonths.map(m => {
        const vList = bucket[m] || [];
        return vList.length > 0 ? (vList.reduce((a,b)=>a+b, 0) / vList.length).toFixed(2) : null;
    });

    mainChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                borderColor: '#45B7AF',
                backgroundColor: fillGradient, 
                fill: true, // Aggiunto per coerenza
                tension: 0.45,
                borderWidth: 4,
                pointRadius: 5,
                pointBackgroundColor: '#FFFFFF',
                pointBorderColor: '#007AFF',
                pointBorderWidth: 3,
                pointHoverRadius: 9,
                spanGaps: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: { 
                legend: { display: false },
                tooltip: {
                    enabled: true, // Aggiunto per coerenza
                    backgroundColor: 'var(--primary-orange)',
                    titleFont: { family: 'Inter', weight: 'bold' },
                    bodyFont: { family: 'Inter', weight: 'bold' },
                    padding: 12,
                    cornerRadius: 10,
                    displayColors: false,
                    callbacks: {
                        label: (context) => `Media: ${context.parsed.y}`
                    }
                }
            },
            scales: {
                y: {
                    min: 0, max: 10,
                    grid: { color: 'rgba(128, 128, 128, 0.2)' }, // Griglia sottile e grigia
                    ticks: { color: textColor, stepSize: 2 }
                },
                x: {
                    grid: { display: true, color: 'rgba(128, 128, 128, 0.1)' }, // Griglia sottile e grigia
                    ticks: { color: textColor }
                }
            }
        },
        plugins: [verticalLinePlugin]
    });
}

function launchSubjectModal() {
    editingSubjectId = null;
    document.getElementById('subject-modal-title').innerText = "Nuova Disciplina Scolastica";
    document.getElementById('btn-save-subject').innerText = "Registra Materia";
    document.getElementById('subject-name').value = '';
    openModal('subject-modal');
}

function saveSubject() {
    const name = document.getElementById('subject-name').value.trim();
    const color = document.getElementById('subject-color')?.value || "#59beba";
    if(!name) return showToast("Inserisci il nome della materia", "error");
    
    if (editingSubjectId) {
        const sub = schoolData.find(s => s.id === editingSubjectId);
        if (sub) {
            sub.name = name; // Aggiunto per coerenza
            sub.color = color;
        }
        editingSubjectId = null;
    } else {
        schoolData.push({ id: Date.now(), name, color, grades: [], scrutinio: { primo:{voto:'-', assenze:0}, secondo:{voto:'-', assenze:0} } });
    }

    updateStorage('myDidupDataDesktop', schoolData);
    document.getElementById('subject-name').value = '';
    closeModal('subject-modal');
    showToast("Dati materia salvati!");
}

function launchEditSubjectModal(id) {
    const sub = schoolData.find(s => s.id === id);
    if (!sub) return;

    editingSubjectId = id;
    document.getElementById('subject-modal-title').innerText = "Modifica Disciplina Scolastica";
    document.getElementById('btn-save-subject').innerText = "Aggiorna Materia";
    document.getElementById('subject-name').value = sub.name;
    document.getElementById('subject-color').value = sub.color || "#59beba";
    
    openModal('subject-modal');
}

function generateStudyPlanHTML(items, title) {
    if (items.length === 0) return `<p class="empty-placeholder">Nessun consiglio di studio al momento.</p>`;
    let html = `<h4 style="margin-bottom:10px; font-size:14px; color:var(--argo-blue-text);">${title}</h4>`;
    items.forEach(item => {
        const prioClass = item.priority === 'Alta' ? 'p-high' : 'p-med'; // Aggiunto per coerenza
        html += `
            <div class="diario-card" style="margin-bottom:8px; padding:10px;">
                <div class="card-prio-indicator ${prioClass}"></div>
                <div style="flex:1">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span class="subj-tag">${item.name}</span>
                        <span style="font-size:10px; color:#64748b;">${item.hours}</span>
                    </div>
                    <p style="font-size:12px; margin-top:4px; font-weight:500;">${item.reason}</p>
                </div>
            </div>
        `;
    });
    return html;
}

function saveGrade() {
    const isSimulation = document.getElementById('is-simulation-flag')?.value === "true";
    const modal = document.getElementById('grade-modal');
    const isAnnotation = modal.classList.contains('annotation-mode');
    
    let subId = parseInt(document.getElementById('current-subject-id').value);
    if (isNaN(subId)) {
        subId = parseInt(document.getElementById('grade-subject-select').value);
    }

    if (isNaN(subId)) return showToast("Seleziona una materia", "error");

    let val;
    if (isAnnotation) {
        val = document.getElementById('grade-annotation-select').value;
    } else {
        const vInput = document.getElementById('grade-value').value;
        if (!vInput) return showToast("Inserisci un voto", "error");
        val = parseFloat(vInput.replace(',', '.'));
        if (isNaN(val) || val < 1 || val > 10) return showToast("Inserisci un voto tra 1 e 10", "error");
    }

    const type = document.getElementById('grade-type').value;
    const date = document.getElementById('grade-date').value;
    // Fallback per il mese se l'input non è presente o vuoto
    let month = parseInt(document.getElementById('grade-month')?.value);
    if (isNaN(month) && date) month = new Date(date).getMonth() + 1;

    const weightVal = document.getElementById('grade-weight').value;
    const weight = weightVal === "0" ? 0 : (parseInt(weightVal) || 100);
    const comment = document.getElementById('grade-comment').value.trim();
    const desc = document.getElementById('grade-desc').value.trim() || "Verifica";

    if (isSimulation && !isNaN(parseFloat(val))) {
        simulateSubjectAvg(subId, val);
        closeModal('grade-modal');
        return;
    }

    if (editingGradeId) {
        const sub = schoolData.find(s => s.id === editingSubId);
        const grade = sub.grades.find(g => g.id === editingGradeId);
        Object.assign(grade, { value: val, month, type, date, desc, weight, comment });
        editingGradeId = null; editingSubId = null;
    } else {
        const sub = schoolData.find(s => s.id === subId);
        if(sub) {
            sub.grades.push({ id: Date.now(), value: val, month, type, date, desc, weight, comment });
        }
    }

    updateStorage('myDidupDataDesktop', schoolData);
    closeModal('grade-modal');
    showToast("Voto salvato!");

    if (currentSubjectDetailId === subId) {
        openSubjectDetail(subId);
    }
}

function convertPredictionToOfficial() {
    const val = simulatedValues[currentSubjectDetailId];
    // Reset flag simulazione prima di aprire il modale
    const simFlag = document.getElementById('is-simulation-flag');
    if(simFlag) simFlag.value = "false";
    document.getElementById('grade-modal').classList.remove('simulation-mode');

    if (val === undefined || val === null) return;

    // Apriamo il modale di inserimento voto
    launchGradeModal(currentSubjectDetailId);
    
    // Pre-compiliamo il valore numerico con quello simulato
    const gradeInput = document.getElementById('grade-value');
    if (gradeInput) gradeInput.value = val;

    // Rimuoviamo la simulazione ora che sta diventando ufficiale
    clearSimulationFromDetail();
}

function launchEditGradeModal(subId, gradeId) {
    const sub = schoolData.find(s => s.id === subId);
    const grade = sub.grades.find(g => g.id === gradeId);
    
    editingSubId = subId;
    editingGradeId = gradeId;

    const num = parseFloat(grade.value);
    const modal = document.getElementById('grade-modal');

    if (isNaN(num)) {
        modal.classList.add('annotation-mode');
        modal.classList.remove('simulation-mode');
        document.getElementById('grade-value').style.display = 'none';
        document.getElementById('grade-annotation-select').style.display = 'block';
        document.getElementById('grade-annotation-select').value = grade.value;
        document.getElementById('grade-label').innerText = "Annotazione / Giudizio";
    } else {
        modal.classList.remove('annotation-mode', 'simulation-mode');
        document.getElementById('grade-value').style.display = 'block';
        document.getElementById('grade-annotation-select').style.display = 'none';
        document.getElementById('grade-value').value = grade.value;
        document.getElementById('grade-label').innerText = "Voto Numerico (1 - 10)";
    }
    
    document.getElementById('current-subject-id').value = subId;
    document.getElementById('grade-type').value = grade.type;
    document.getElementById('grade-date').value = grade.date;
    document.getElementById('grade-month').value = grade.month;
    document.getElementById('grade-desc').value = grade.desc;
    document.getElementById('grade-weight').value = grade.weight === 0 ? 0 : (grade.weight || 100);
    document.getElementById('grade-comment').value = grade.comment || "";
    
    openModal('grade-modal');
}

function commitHomework() {
    const title = document.getElementById('hw-title').value.trim();
    const subj = document.getElementById('hw-subject-select')?.value;
    const date = document.getElementById('hw-date').value;
    const prio = document.getElementById('hw-priority').value;
    if(!title || !subj) return showToast("Dati mancanti", "error");
    homeworkTasks.push({ id: Date.now(), title, subject: subj, expiry: date, priority: prio });
    updateStorage('myDidupHomeworkDesktop', homeworkTasks);
    document.getElementById('hw-title').value = '';
    closeModal('homework-modal');
    showToast("Compito salvato!");
}

function commitReminder() {
    const title = document.getElementById('rem-title').value.trim();
    const subj = document.getElementById('rem-subject-select')?.value;
    const date = document.getElementById('rem-date').value;
    const type = document.getElementById('rem-type').value;
    if(!title || !subj) return showToast("Dati mancanti", "error");
    reminderTasks.push({ id: Date.now(), title, subject: subj, date, type });
    updateStorage('myDidupRemindersDesktop', reminderTasks);
    document.getElementById('rem-title').value = '';
    closeModal('reminder-modal');
    showToast("Promemoria aggiunto!");
}

function commitEvent() {
    const title = document.getElementById('event-title').value.trim();
    const date = document.getElementById('event-date').value;
    const cat = document.getElementById('event-category').value;
    
    if(!title) return showToast("Inserisci un oggetto", "error");
    systemEvents.push({ id: Date.now(), title, date, category: cat });
    updateStorage('myDidupEventsDesktop', systemEvents);
    document.getElementById('event-title').value = '';
    closeModal('event-modal');
    showToast("Comunicazione pubblicata!");
}

function commitAttendance() {
    const type = document.getElementById('att-type').value;
    const date = document.getElementById('att-date').value;
    const hours = parseFloat(document.getElementById('att-hours').value) || 0;
    const reason = document.getElementById('att-reason').value.trim();
    attendanceEvents.push({ id: Date.now(), type, date, hours: hours, reason: reason || "Nota non inserita", justified: false });
    updateStorage('myDidupAttendanceDesktop', attendanceEvents);
    document.getElementById('att-reason').value = '';
    document.getElementById('att-hours').value = '';
    closeModal('attendance-modal');
    showToast("Evento appello registrato!");
}

function justifyEvent(id) {
    const e = attendanceEvents.find(x => x.id === id);
    if(e) { e.justified = true; updateStorage('myDidupAttendanceDesktop', attendanceEvents); }
}

function toggleReminder(id) {
    const rem = reminderTasks.find(r => r.id === id);
    if(rem) {
        rem.completed = !rem.completed;
        updateStorage('myDidupRemindersDesktop', reminderTasks);
    }
}

function simulateSubjectAvg(subId, val) {
    const res = document.getElementById(`sim-res-${subId}`);
    if(!val) { 
        delete simulatedValues[subId]; 
        if(res) res.innerText = "--";
        recalculateDesktopSystem(); 
        return; 
    }
    const num = parseFloat(val);
    simulatedValues[subId] = num;
    const sub = schoolData.find(s => s.id === subId);
    const sum = sub.grades.reduce((a,b)=>a+b.value, 0);
    if(res) res.innerText = ((sum + num) / (sub.grades.length + 1)).toFixed(2);
    recalculateDesktopSystem();
    updatePredictionUI(subId);
}

function updatePredictionUI(subId) {
    const sub = schoolData.find(s => s.id === subId);
    if(!sub || !simulatedValues[subId]) return;

    const fGrades = filterGradesByPeriod(sub.grades || []);
    const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
    const newSubAvg = ((weightedSum + simulatedValues[subId]) / (totalWeight + 1)).toFixed(2);

    const infoBox = document.getElementById('prediction-info-box');
    const text = document.getElementById('pred-averages-text');
    if(infoBox && text) {
        infoBox.style.display = 'flex'; // Aggiunto per coerenza
        text.innerText = `Simulazione: con un ${simulatedValues[subId]} la media di ${sub.name} diventerebbe ${newSubAvg}`;
    }
}

function saveScrutinioChanges() {
    const id = parseInt(document.getElementById('scrutinio-edit-sub-id').value);
    const v = document.getElementById('scrutinio-input-voto').value;
    const a = document.getElementById('scrutinio-input-assenze').value;
    const sub = schoolData.find(s => s.id === id);
    if(sub) {
        sub.scrutinio[currentScrutinioPeriod] = { voto: v || '-', assenze: a ? parseInt(a) : 0 };
        updateStorage('myDidupDataDesktop', schoolData);
        showToast("Scrutinio aggiornato!");
    }
    closeModal('scrutinio-modal');
}

function deleteSubject(id) { if (confirm("Eliminare la materia e tutti i voti?")) { schoolData = schoolData.filter(s => s.id !== id); updateStorage('myDidupDataDesktop', schoolData); } }

function removeHomework(id) { homeworkTasks = homeworkTasks.filter(x => x.id !== id); updateStorage('myDidupHomeworkDesktop', homeworkTasks); }
function removeReminder(id) { reminderTasks = reminderTasks.filter(x => x.id !== id); updateStorage('myDidupRemindersDesktop', reminderTasks); }
function removeEvent(id) { systemEvents = systemEvents.filter(x => x.id !== id); updateStorage('myDidupEventsDesktop', systemEvents); showToast("Evento eliminato"); }
function removeAttendance(id) { attendanceEvents = attendanceEvents.filter(x => x.id !== id); updateStorage('myDidupAttendanceDesktop', attendanceEvents); }

function deleteGrade(subId, gradeId) { 
    const s = schoolData.find(x => x.id === subId); 
    if(s && confirm("Eliminare il voto?")) { 
        s.grades = s.grades.filter(x => x.id !== gradeId); 
        updateStorage('myDidupDataDesktop', schoolData);
        // Refresh immediato del dettaglio se aperto
        openSubjectDetail(subId);
    } 
}

function toggleAccordion(id) { openAccordionId = (openAccordionId === id) ? null : id; renderSubjectsAccordion(); }
function launchGradeModal(id) { 
    document.getElementById('current-subject-id').value = id; 
    if(document.getElementById('quick-grade-container')) {
        const cont = document.getElementById('quick-grade-container');
        cont.style.display = 'none';
        cont.classList.remove('quick-grade-entrance');
    }
    const group = document.getElementById('grade-subject-group');
    if(group) group.style.display = 'none';
    openModal('grade-modal'); 
} // Aggiunto per coerenza
function launchScrutinioModal(id) { const s = schoolData.find(x => x.id === id); if(s) { document.getElementById('scrutinio-edit-sub-id').value = id; document.getElementById('scrutinio-edit-sub-name').value = s.name; document.getElementById('scrutinio-input-voto').value = s.scrutinio[currentScrutinioPeriod].voto !== '-' ? s.scrutinio[currentScrutinioPeriod].voto : ''; document.getElementById('scrutinio-input-assenze').value = s.scrutinio[currentScrutinioPeriod].assenze; openModal('scrutinio-modal'); } }
function setDiarioView(m) { 
    currentDiarioView = m; 
    document.querySelectorAll('#tab-diario .segment-btn').forEach(b => b.classList.remove('active')); 
    if (document.getElementById('view-' + m)) document.getElementById('view-' + m).classList.add('active'); 
    renderDiarioSection(); 
    renderWeeklyCalendar();
}
function filterPeriod(p) { currentPeriod = p; document.querySelectorAll('#tab-voti .segment-btn').forEach(b => b.classList.remove('active')); if(document.getElementById('btn-p-' + p)) document.getElementById('btn-p-' + p).classList.add('active'); recalculateDesktopSystem(); }
function switchScrutinioPeriod(p) { currentScrutinioPeriod = p; document.querySelectorAll('.scrutinio-nav-block').forEach(b => b.classList.remove('active')); if(document.getElementById('scrut-menu-' + p)) document.getElementById('scrut-menu-' + p).classList.add('active'); renderScrutinioTable(); }
function downloadPDFReport() {
    if(!window.jspdf) return showToast("Libreria PDF mancante", "error");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    const periodName = currentPeriod === 'primo' ? '1° Quadrimestre' : (currentPeriod === 'secondo' ? '2° Quadrimestre' : 'Intero Anno');
    const userName = localStorage.getItem('myDidupUserName') || "STUDENTE";

    // Header Estetico
    doc.setFontSize(22); // Aggiunto per coerenza
    doc.setTextColor(43, 76, 126); // argo-blue-text
    doc.text("VOTI GIORNALIERI", 15, 20);
    doc.setFontSize(10);
    doc.setTextColor(89, 190, 186); // argo-teal
    doc.text("didUP FAMIGLIA • REGISTRO PERSONALE", 15, 26);

    doc.setFontSize(11);
    doc.setTextColor(100); // Aggiunto per coerenza
    doc.text(`Studente: ${userName.toUpperCase()}`, 15, 38);
    doc.text(`Periodo: ${periodName}`, 15, 44);
    doc.text(`Data Generazione: ${new Date().toLocaleDateString('it-IT')}`, 140, 44);
    
    doc.setDrawColor(89, 190, 186);
    doc.setLineWidth(0.5);
    doc.line(15, 48, 195, 48);
    
    let y = 60;

    schoolData.forEach(s => {
        const fGrades = filterGradesByPeriod(s.grades || []);
        if (fGrades.length === 0) return;

        // Controllo spazio per header materia prima di stampare
        if (y > 240) { doc.addPage(); y = 20; } // Aggiunto per coerenza

        // Box Header Materia
        doc.setFillColor(241, 245, 249);
        doc.rect(15, y, 180, 10, 'F');
        doc.setFont("helvetica", "bold");
        doc.setTextColor(43, 76, 126);
        doc.setFontSize(12);
        doc.text(s.name.toUpperCase(), 18, y + 7);

        const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
        const avg = totalWeight > 0 ? (weightedSum / totalWeight).toFixed(2) : "--";
        doc.setFontSize(10);
        doc.text(`MEDIA: ${avg}`, 165, y + 7); // Aggiunto per coerenza
        y += 18;

        // Intestazione Tabella Materia
        doc.setFontSize(9);
        doc.setTextColor(100);
        doc.text("DATA", 18, y);
        doc.text("TIPO", 45, y);
        doc.text("VOTO", 75, y);
        doc.text("DESCRIZIONE / ARGOMENTO", 95, y);
        y += 4;
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.1);
        doc.line(15, y, 195, y);
        y += 8;

        // Ordina voti per data decrescente
        fGrades.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(g => {
            if (y > 275) { doc.addPage(); y = 20; } // Aggiunto per coerenza
            
            doc.setFont("helvetica", "normal");
            doc.setTextColor(50);
            doc.text(new Date(g.date).toLocaleDateString('it-IT'), 18, y);
            doc.text(g.type, 45, y);
            
            const num = parseFloat(g.value);
            if (!isNaN(num)) {
                if (num >= 6) doc.setTextColor(16, 185, 129); // Verde
                else if (num >= 5) doc.setTextColor(245, 158, 11); // Arancio
                else doc.setTextColor(239, 68, 68); // Rosso
            } else if (g.value === '+') {
                doc.setTextColor(16, 185, 129);
            } else if (g.value === '-') {
                doc.setTextColor(239, 68, 68);
            } else {
                doc.setTextColor(100); // Grigio per annotazioni
            }
            
            doc.setFont("helvetica", "bold");
            doc.text(g.value.toString(), 75, y);
            
            doc.setFont("helvetica", "normal");
            doc.setTextColor(100);
            doc.setFontSize(8);
            const desc = g.desc || "Voto registrato";
            doc.text(desc.length > 65 ? desc.substring(0, 62) + "..." : desc, 95, y);
            doc.setFontSize(9);
            
            y += 8;
        });

        y += 12; // Spazio tra una materia e l'altra
    });

    doc.save(`Voti_Giornalieri_${new Date().toISOString().slice(0,10)}.pdf`);
    showToast("Documento PDF generato!");
}

function downloadTimetablePDF() {
    if(!window.jspdf) return showToast("Libreria PDF mancante", "error");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
    });
    
    // 1. LOGICA DATE - Identifica la settimana corretta
    let monday = calendarReferenceDate;
    if (!monday) {
        const today = new Date();
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1); 
        monday = new Date(today.setDate(diff));
        monday.setHours(0,0,0,0);
    }
    const startWeek = new Date(monday);
    const endWeek = new Date(monday);
    endWeek.setDate(monday.getDate() + 5); // Sabato

    const dateRange = `${startWeek.toLocaleDateString('it-IT', {day:'numeric', month:'long'})} - ${endWeek.toLocaleDateString('it-IT', {day:'numeric', month:'long', year:'numeric'})}`;

    const userName = localStorage.getItem('myDidupUserName') || "STUDENTE";
    const days = ["LUNEDÌ", "MARTEDÌ", "MERCOLEDÌ", "GIOVEDÌ", "VENERDÌ", "SABATO"];

    // 2. HEADER ULTRA-MODERNO // Aggiunto per coerenza
    doc.setFillColor(0, 122, 255); 
    doc.rect(0, 0, 297, 50, 'F');
    
    doc.setFontSize(28);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text("ORARIO SCOLASTICO", 15, 22);
    
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text(userName.toUpperCase() + " • CLASSE " + (localStorage.getItem('myDidupUserClass') || "NON SPEC.").toUpperCase(), 15, 30);
    doc.setFont("helvetica", "bold");
    doc.text(dateRange.toUpperCase(), 15, 38);

    // Elemento decorativo (Zaino stilizzato)
    doc.setFillColor(255, 255, 255); // Aggiunto per coerenza
    doc.setGState(new doc.GState({opacity: 0.2}));
    doc.roundedRect(255, 12, 25, 25, 4, 4, 'F');
    doc.setGState(new doc.GState({opacity: 1.0}));
    doc.setFontSize(16);
    doc.text("🎒", 262, 28);

    const startX = 12; // Più margine a sinistra
    const startY = 52; // Abbassato header per dare spazio
    const colWidth = 44; // Leggermente più largo
    const rowHeight = 18; // Ridotto per far stare la 7° ora
    const spacing = 1.5; // Spaziatura ottimizzata
    const borderRadius = 3;

    // 3. INTESTAZIONI GIORNI CON DATE CHIARE // Aggiunto per coerenza
    doc.setFont("helvetica", "bold");
    days.forEach((day, i) => {
        const currX = startX + 22 + (i * colWidth);
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateNum = d.getDate();

        doc.setFillColor(245, 247, 250); // Aggiunto per coerenza
        doc.roundedRect(currX, startY - 9, colWidth - spacing, 8, 2, 2, 'F');

        doc.setFontSize(9);
        doc.setTextColor(0, 122, 255);
        doc.text(day, currX + (colWidth/2) - 1, startY - 5, { align: 'center' });
        
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(dateNum.toString(), currX + (colWidth/2) - 1, startY - 2, { align: 'center' });
    });

    // 4. GRIGLIA LEZIONI // Aggiunto per coerenza
    for (let h = 1; h <= 7; h++) {
        let currY = startY + 4 + ((h-1) * (rowHeight + spacing));
        
        // Box Ora
        doc.setFillColor(241, 245, 249);
        doc.setDrawColor(230, 230, 230);
        doc.roundedRect(startX, currY, 15, rowHeight, borderRadius, borderRadius, 'FD');
        doc.setFont("helvetica", "bold");
        doc.setTextColor(43, 76, 126);
        doc.setFontSize(10);
        doc.text(`${h}°`, startX + 7.5, currY + (rowHeight/2) + 2, { align: 'center' });

        for (let d = 0; d < days.length; d++) {
            let currX = startX + 18 + (d * colWidth);
            const cellId = `${d}-${h}`;
            const data = schoolTimetable[cellId];

            if (data) {
                const subObj = schoolData.find(s => s.name === data.subject);
                const color = (subObj && subObj.color) ? subObj.color : "#FFFFFF";
                const hex = color.replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);

                doc.setFillColor(r, g, b);
                doc.setDrawColor(r-15, g-15, b-15); 
                doc.roundedRect(currX, currY, colWidth - spacing, rowHeight, borderRadius, borderRadius, 'FD');
                
                const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                doc.setTextColor(brightness > 155 ? 50 : 255);

                doc.setFont("helvetica", "bold");
                doc.setFontSize(8.5);
                
                let subLines = doc.splitTextToSize(data.subject, colWidth - 6);
                doc.text(subLines, currX + 4, currY + 6);
                
                doc.setFont("helvetica", "normal");
                doc.setFontSize(7);
                if(data.teacher) doc.text(data.teacher, currX + 4, currY + 11);
                if(data.room) doc.text("Aula: " + data.room, currX + 4, currY + 15);
            } else {
                doc.setDrawColor(245, 245, 245);
                doc.roundedRect(currX, currY, colWidth - spacing, rowHeight, borderRadius, borderRadius, 'S');
            }
        }
    }

    // 5. FOOTER PROFESSIONALE // Aggiunto per coerenza
    doc.setFontSize(8);
    doc.setTextColor(180);
    const footerY = 195;
    doc.text(`Generato da didUP NextGen il ${new Date().toLocaleString('it-IT')}`, 15, footerY);
    doc.text(`Pagina 1 di 1`, 282, footerY, { align: 'right' });

    doc.save(`Orario_Scolastico_${startWeek.toISOString().slice(0,10)}.pdf`);
    showToast("Orario PDF generato!");
}

async function handlePDFImport() {
    const fileInput = document.getElementById('pdf-file-input');
    const status = document.getElementById('pdf-import-status');
    const btn = document.getElementById('btn-start-pdf-import');
    const spinner = document.getElementById('pdf-loading-spinner');

    if (!fileInput.files.length) return showToast("Seleziona un file", "error"); // Aggiunto per coerenza

    const file = fileInput.files[0];
    btn.disabled = true;
    spinner.style.display = 'inline-block'; // Mostra lo spinner
    status.innerText = "⏳ Lettura file in corso...";
    status.style.color = "var(--argo-blue-text)";

    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        let fullText = "";

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            let lastY;
            let pageText = "";
            
            for (let item of textContent.items) {
                if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 2) {
                    pageText += "\n";
                }
                pageText += item.str + " ";
                lastY = item.transform[5];
            }
            fullText += pageText + "\n";
        }

        parseAndInjectGrades(fullText);
        
        status.innerText = "✅ Importazione completata con successo!";
        if (currentUser) saveDataToCloud(); // Sincronizza subito i nuovi voti sul cloud
        status.style.color = "#10b981";
        spinner.style.display = 'none'; // Nasconde lo spinner
        setTimeout(() => {
            closeModal('pdf-import-modal');
            btn.disabled = false;
            status.innerText = "";
            fileInput.value = "";
        }, 2000);

    } catch (error) {
        console.error(error);
        status.innerText = "❌ Errore durante l'importazione.";
        status.style.color = "#ef4444";
        spinner.style.display = 'none'; // Nasconde lo spinner in caso di errore
        btn.disabled = false;
    }
}

function parseAndInjectGrades(text) {
    const lines = text.split('\n');
    let importedCount = 0;

    lines.forEach(line => {
        const cleanLine = line.trim();
        if (!cleanLine) return;

        const dateMatches = [...cleanLine.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
        const gradeMatches = [...cleanLine.matchAll(/\b([1-9]([.,]\d{1,2})?|10)\b/g)];

        if (dateMatches.length > 0 && gradeMatches.length > 0) {
            let targetSubject = schoolData.find(s => cleanLine.toUpperCase().includes(s.name.toUpperCase()));

            if (targetSubject) {
                const pairCount = Math.min(dateMatches.length, gradeMatches.length);
                
                for (let i = 0; i < pairCount; i++) {
                    const dMatch = dateMatches[i];
                    const gMatch = gradeMatches[i];

                    const day = dMatch[1];
                    const month = parseInt(dMatch[2]);
                    const year = dMatch[3];
                    const gradeValue = parseFloat(gMatch[1].replace(',', '.'));
                    const dateStr = `${year}-${dMatch[2]}-${day}`;

                    const isDuplicate = targetSubject.grades.some(g => g.date === dateStr && g.value === gradeValue);
                    
                    if (!isDuplicate) {
                        targetSubject.grades.push({
                            id: Date.now() + Math.random(),
                            value: gradeValue,
                            month: month,
                            type: "Importato",
                            date: dateStr,
                            desc: "Voto importato da PDF",
                            weight: 100,
                            comment: ""
                        });
                        importedCount++;
                    }
                }
            }
        }
    });

    if (importedCount > 0) {
        localStorage.setItem('myDidupDataDesktop', JSON.stringify(schoolData));
        recalculateDesktopSystem();
        showToast(`Importati ${importedCount} nuovi voti!`);
    } else {
        showToast("Nessun nuovo voto trovato nel PDF", "error");
    }
}

function exportDatabase() {
    const data = {
        schoolData: JSON.parse(localStorage.getItem('myDidupDataDesktop')) || [],
        homework: JSON.parse(localStorage.getItem('myDidupHomeworkDesktop')) || [],
        reminders: JSON.parse(localStorage.getItem('myDidupRemindersDesktop')) || [],
        events: JSON.parse(localStorage.getItem('myDidupEventsDesktop')) || [],
        attendance: JSON.parse(localStorage.getItem('myDidupAttendanceDesktop')) || [],
        timetable: JSON.parse(localStorage.getItem('myDidupTimetableDesktop')) || {}
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `didup_backup_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Backup creato! Invialo all'iPhone per sincronizzare.");
}

// ========================================================
// NUOVE FUNZIONI PER OBIETTIVI SETTIMANALI
// ========================================================

function getWeeklyStudyPlan() {
    const studyPlan = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Normalizza la data di oggi

    // 1. Identifica le materie insufficienti (media < 6) // Aggiunto per coerenza
    const insufficientSubjects = schoolData.map(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
        const avg = totalWeight > 0 ? (weightedSum / totalWeight) : null;
        if (avg !== null && avg < 6) { // Solo materie con media inferiore a 6
            let hours = '1.5h';
            if (avg < 5) hours = '2h+'; // Più ore se la media è molto bassa
            return { name: sub.name, avg: avg.toFixed(2), hours: hours, id: sub.id };
        }
        return null;
    }).filter(Boolean); // Rimuovi le voci nulle

    if (insufficientSubjects.length === 0) {
        return []; // Nessuna materia insufficiente, nessun piano di studio
    }

    // Nomi dei giorni della settimana per visualizzazione // Aggiunto per coerenza
    const daysOfWeekNames = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

    // Mappa per una ricerca rapida delle materie nell'orario, mappando il nome della materia a un Set di indici del giorno dell'orario (0=Lun, 1=Mar, ..., 5=Sab)
    const timetableSubjectDays = {};
    for (const cellId in schoolTimetable) {
        const [timetableDayIdx, hourIdx] = cellId.split('-').map(Number); // timetableDayIdx è 0-5 (Lun-Sab)
        const subjectName = schoolTimetable[cellId].subject;
        if (!timetableSubjectDays[subjectName]) {
            timetableSubjectDays[subjectName] = new Set();
        }
        timetableSubjectDays[subjectName].add(timetableDayIdx);
    }

    insufficientSubjects.forEach(sub => {
        let recommendedStudyDayName = null;
        let classDayName = null;

        // Itera attraverso i prossimi 7 giorni (partendo da domani) per trovare la prossima lezione per questa materia
        for (let i = 1; i <= 7; i++) { // Inizia da domani (i=1)
            const currentDay = new Date(today);
            currentDay.setDate(today.getDate() + i);
            const currentDayOfWeek = currentDay.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab

            // Converti currentDayOfWeek (0-6) in timetableDayIdx (0-5 per Lun-Sab) // Aggiunto per coerenza
            let timetableDayIdxForCurrentDay = -1;
            if (currentDayOfWeek >= 1 && currentDayOfWeek <= 6) { // Dal Lunedì al Sabato
                timetableDayIdxForCurrentDay = currentDayOfWeek - 1;
            }

            if (timetableDayIdxForCurrentDay !== -1 && timetableSubjectDays[sub.name] && timetableSubjectDays[sub.name].has(timetableDayIdxForCurrentDay)) {
                // Trovata una lezione per questa materia in currentDay
                classDayName = daysOfWeekNames[currentDayOfWeek];
                
                // Raccomanda di studiare il giorno prima
                const studyDayOfWeek = (currentDayOfWeek === 0) ? 6 : currentDayOfWeek - 1; // Se la lezione è Lunedì (1), studia Domenica (0). Se la lezione è Domenica (0), studia Sabato (6).
                recommendedStudyDayName = daysOfWeekNames[studyDayOfWeek];
                break; // Trovata la prossima lezione, smetti di cercare per questa materia
            }
        }

        if (recommendedStudyDayName) {
            studyPlan.push({
                name: sub.name,
                reason: `Media: ${sub.avg}. Prepara la lezione di ${classDayName}.`,
                priority: sub.avg < 5 ? 'Alta' : 'Media',
                hours: sub.hours,
                studyDay: recommendedStudyDayName
            });
        } else {
            // Se non è stata trovata nessuna lezione nei prossimi 7 giorni, raccomanda di studiare in generale
            studyPlan.push({
                name: sub.name,
                reason: `Media: ${sub.avg}. Nessuna lezione in programma a breve.`,
                priority: sub.avg < 5 ? 'Alta' : 'Media',
                hours: sub.hours,
                studyDay: 'Qualsiasi giorno'
            });
        }
    });

    // Ordina il piano di studio per priorità (Alta per prima) // Aggiunto per coerenza
    return studyPlan.sort((a, b) => (a.priority === 'Alta' ? -1 : 1));
}

function getGeneralStudyRecommendations(lookAheadDays) {
    const subjectsToStudy = [];
    const now = new Date().setHours(0,0,0,0);
    const targetInput = document.getElementById('target-avg-input');
    const target = (targetInput && targetInput.value) ? parseFloat(targetInput.value) : null;

    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
        const avg = totalWeight > 0 ? (weightedSum / totalWeight) : null;
        
        if (avg !== null) {
            const isSottoSei = avg < 6;
            const isSottoTarget = target !== null && avg < (target - 0.3);

            if (isSottoSei || isSottoTarget) {
                const reason = isSottoSei ? `Sotto il 6 (${avg.toFixed(2)})` : `Sotto target (${avg.toFixed(2)})`;
                const priority = isSottoSei ? 'Alta' : 'Media';
                subjectsToStudy.push({ name: sub.name, reason, priority, hours: '1.5h' });
            }
        }
    });

    reminderTasks.forEach(rem => {
        const remTime = new Date(rem.date).setHours(0,0,0,0);
        const diffDays = Math.ceil((remTime - now) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= lookAheadDays) {
            subjectsToStudy.push({ name: rem.subject, reason: `Verifica il ${rem.date}`, priority: 'Alta', hours: '2h+' });
        }
    });
    return subjectsToStudy.sort((a, b) => (a.priority === 'Alta' ? -1 : 1));
}

function commitVacation() {
    const desc = document.getElementById('vac-desc').value.trim();
    const start = document.getElementById('vac-start').value;
    const end = document.getElementById('vac-end').value;
    const editId = document.getElementById('vac-edit-id').value;

    if (!desc || !start || !end) return showToast("Dati mancanti", "error");

    if (editId) {
        const vac = schoolVacations.find(v => v.id == editId);
        if (vac) {
            vac.desc = desc;
            vac.start = start;
            vac.end = end;
            showToast("Periodo vacanza aggiornato!");
        }
    } else {
        schoolVacations.push({ id: Date.now(), desc, start, end });
        showToast("Periodo vacanza aggiunto!");
    }

    updateStorage('myDidupVacationsDesktop', schoolVacations);
    resetVacationForm();
    renderVacationsList();
}

function editVacation(id) {
    const v = schoolVacations.find(vac => vac.id === id);
    if (!v) return;
    document.getElementById('vac-edit-id').value = v.id;
    document.getElementById('vac-desc').value = v.desc;
    document.getElementById('vac-start').value = v.start;
    document.getElementById('vac-end').value = v.end;
    const btn = document.getElementById('btn-commit-vacation');
    if (btn) btn.innerText = "Aggiorna Periodo";
}

function resetVacationForm() {
    document.getElementById('vac-edit-id').value = '';
    document.getElementById('vac-desc').value = '';
    document.getElementById('vac-start').value = '';
    document.getElementById('vac-end').value = '';
    const btn = document.getElementById('btn-commit-vacation');
    if (btn) btn.innerText = "Aggiungi Periodo";
}

function renderVacationsList() {
    const hook = document.getElementById('vacations-list-hook');
    if (!hook) return;
    hook.innerHTML = schoolVacations.map(v => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--argo-body-bg); padding:8px; border-radius:8px; margin-bottom:5px; font-size:12px;">
            <div>
                <div style="font-weight:700;">${v.desc}</div>
                <div style="font-size:10px; color:#64748b;">Dal ${v.start} al ${v.end}</div>
            </div>
            <div style="display:flex; gap:8px;">
                <button class="btn-inline-del" onclick="editVacation(${v.id})" style="color: var(--argo-blue-text)">✏️</button>
                <button class="btn-delete-task" onclick="removeVacation(${v.id})">🗑️</button>
            </div>
        </div>`).join('') || '<p class="empty-placeholder">Nessun periodo inserito.</p>';
}

function removeVacation(id) {
    schoolVacations = schoolVacations.filter(v => v.id !== id);
    updateStorage('myDidupVacationsDesktop', schoolVacations);
    renderVacationsList();
}

function importDatabase(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const d = JSON.parse(e.target.result);
            
            // Aggiorna variabili globali e localStorage
            if(d.schoolData) { // Correzione: d.schoolData invece di d.schoolData
                schoolData = d.schoolData;
                localStorage.setItem(getTredKey('myDidupDataDesktop'), JSON.stringify(schoolData));
            }
            if(d.homework) {
                homeworkTasks = d.homework;
                localStorage.setItem(getTredKey('myDidupHomeworkDesktop'), JSON.stringify(homeworkTasks));
            }
            if(d.reminders) {
                reminderTasks = d.reminders;
                localStorage.setItem(getTredKey('myDidupRemindersDesktop'), JSON.stringify(reminderTasks));
            }
            if(d.events) {
                systemEvents = d.events;
                localStorage.setItem(getTredKey('myDidupEventsDesktop'), JSON.stringify(systemEvents));
            }
            if(d.attendance) {
                attendanceEvents = d.attendance;
                localStorage.setItem(getTredKey('myDidupAttendanceDesktop'), JSON.stringify(attendanceEvents));
            }
            if(d.timetable) {
                schoolTimetable = d.timetable;
                localStorage.setItem(getTredKey('myDidupTimetableDesktop'), JSON.stringify(schoolTimetable));
            }

            // Se l'utente è loggato, forza il salvataggio sul cloud prima del refresh
            if (currentUser) {
                if (window.AppInstance && window.AppInstance.saveDataToCloud) await window.AppInstance.saveDataToCloud();
            }

            showToast("Dati sincronizzati! Riavvio...", "success");
            setTimeout(() => location.reload(), 1500);
        } catch(err) { showToast("Errore: il file non è valido", "error"); }
    };
    reader.readAsText(file);
}

/**
 * Abilita l'editing inline del nome della materia.
 * @param {number} subId - ID della materia.
 * @param {string} elementId - ID dell'elemento HTML da trasformare in input.
 */
function enableSubjectNameEdit(subId, elementId) {
    const displayElement = document.getElementById(elementId);
    if (!displayElement) return;

    const currentName = displayElement.innerText;
    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.className = 'edit-subject-input';
    inputField.value = currentName;

    // BLOCCA IL BUBBLING: cliccare sull'input non deve attivare il click della card genitore
    inputField.addEventListener('click', (e) => e.stopPropagation());

    // Sostituisci l'elemento di visualizzazione con il campo input
    displayElement.replaceWith(inputField);
    inputField.focus();
    inputField.select(); // Facilita la modifica selezionando il testo esistente

    const saveChanges = async () => {
        const newName = inputField.value.trim();
        if (newName && newName !== currentName) {
            // Aggiorna temporaneamente il testo per feedback visivo immediato
            displayElement.innerText = newName;
            inputField.replaceWith(displayElement);
            // Salva permanentemente nello stato e nello storage
            await saveEditedSubjectName(subId, newName);
        } else {
            // Se non c'è modifica o il campo è vuoto, ripristina il nodo originale
            inputField.replaceWith(displayElement);
        }
    };

    inputField.addEventListener('blur', saveChanges, { once: true });
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            inputField.blur(); // Triggera saveChanges via blur
        } else if (e.key === 'Escape') {
            inputField.value = currentName; // Annulla le modifiche
            inputField.blur();
        }
    });
}

/**
 * Salva il nome della materia modificato, riordina e aggiorna l'interfaccia.
 */
async function saveEditedSubjectName(subId, newName) {
    const sub = schoolData.find(s => s.id === subId);
    if (!sub) return;

    sub.name = newName;

    // Riordinamento A-Z automatico basato sul nuovo nome
    schoolData.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

    // Salva nello storage (chiama anche recalculateDesktopSystem internamente)
    await updateStorage('myDidupDataDesktop', schoolData);
    showToast(`Materia "${newName}" aggiornata con successo!`, "success");

    // Aggiorna la lista delle materie per riflettere il nuovo ordine
    renderSubjectsAccordion();
}

function resetToDefaultSubjects() {
    if(confirm("Sei sicuro di voler resettare tutti i dati?")) {
        localStorage.clear();
        location.reload();
    }
}

// ========================================================
// FUNZIONI AGGIUNTIVE MANCANTI
// ========================================================

function saveUserSettings() {
    const name = document.getElementById('input-user-name').value.trim();
    const uClass = document.getElementById('input-user-class').value.trim();
    
    // Salva date periodi se presenti
    const t1s = document.getElementById('term1-start')?.value;
    const t1e = document.getElementById('term1-end')?.value;
    const t2e = document.getElementById('term2-end')?.value;

    if (t1s || t1e || t2e) {
        const existing = JSON.parse(localStorage.getItem(getTredKey('myDidupTermDates'))) || {};
        const termSettings = { ...existing, p1_start: t1s || existing.p1_start, p1_end: t1e || existing.p1_end, p2_end: t2e || existing.p2_end };
        localStorage.setItem(getTredKey('myDidupTermDates'), JSON.stringify(termSettings));
    }
    
    const s1 = document.getElementById('input-nav-1').value;
    const s2 = document.getElementById('input-nav-2').value;
    const s3 = document.getElementById('input-nav-3').value;
    const hideLabels = document.getElementById('input-hide-nav-labels').checked;
    navSettings = { slot1: s1, slot2: s2, slot3: s3, hideLabels: hideLabels };
    localStorage.setItem('myDidupNavSettings', JSON.stringify(navSettings)); // Aggiunto per coerenza
    renderBottomNav();

    if(name) {
        localStorage.setItem('myDidupUserName', name);
        if(document.getElementById('display-name')) document.getElementById('display-name').innerText = name.toUpperCase();
        if(document.getElementById('user-avatar')) document.getElementById('user-avatar').innerText = name.charAt(0).toUpperCase();
    }
    if(uClass) {
        localStorage.setItem('myDidupUserClass', uClass);
        if(document.getElementById('display-class')) document.getElementById('display-class').innerText = uClass;
    }
    
    closeModal('user-settings-modal');
    showToast("Profilo aggiornato!");
}

/**
 * Gestisce l'apertura/chiusura della tabella voti rapidi
 */
function toggleQuickGrades() {
    const cont = document.getElementById('quick-grade-container');
    const grid = document.getElementById('quick-grade-grid');
    if (!cont || !grid) return;

    if (cont.style.display === 'none') {
        if (grid.children.length === 0) {
            let grades = [{label: '1-', value: 0.85}]; // Partenza speciale
            for (let i = 1; i <= 9; i++) {
                grades.push({label: i.toString(), value: i});
                grades.push({label: i + '+', value: i + 0.15});
                grades.push({label: i + '½', value: i + 0.5});
                grades.push({label: (i + 1) + '-', value: i + 0.85});
            }
            grades.push({label: '10', value: 10});

            grid.innerHTML = grades.map(g => `
                <button type="button" class="quick-grade-btn" onclick="setQuickGrade(${g.value})">${g.label}</button>
            `).join('');
        }
        cont.style.display = 'block';
        cont.classList.add('quick-grade-entrance');
    } else {
        cont.style.display = 'none';
        cont.classList.remove('quick-grade-entrance');
    }
}

/**
 * Imposta il valore nel campo input e aggiorna l'anteprima
 */
function setQuickGrade(val) {
    const input = document.getElementById('grade-value');
    if (input) {
        input.value = val;
        input.dispatchEvent(new Event('input')); // Forza l'aggiornamento della bolla colorata
    }
    const cont = document.getElementById('quick-grade-container');
    if (cont) {
        cont.style.display = 'none';
        cont.classList.remove('quick-grade-entrance');
    }
}

function openOfficialGrade() {
    // Svuota i campi per evitare residui di input precedenti // Aggiunto per coerenza
    document.getElementById('grade-value').value = '';
    document.getElementById('grade-desc').value = '';
    document.getElementById('grade-comment').value = '';
    if(document.getElementById('quick-grade-container')) {
        const cont = document.getElementById('quick-grade-container');
        cont.style.display = 'none';
        cont.classList.remove('quick-grade-entrance');
    }

    const preview = document.getElementById('grade-graphic-display');
    if (preview) {
        preview.innerText = '-';
        preview.className = 'grade-bubble g-grey';
        preview.style.display = 'none';
    }

    const modal = document.getElementById('grade-modal');
    modal.classList.remove('simulation-mode', 'annotation-mode');
    document.getElementById('grade-value').style.display = 'block';
    document.getElementById('grade-annotation-select').style.display = 'none';
    document.getElementById('grade-label').innerText = "Voto Numerico (1 - 10)";
    document.getElementById('grade-modal-title').innerText = "Registra Valutazione";
    document.getElementById('btn-save-grade').innerText = "Salva nel Registro";

    // Determina se mostrare il selettore materia // Aggiunto per coerenza
    // Lo mostriamo se NON siamo dentro il dettaglio di una materia (modal dettaglio aperto)
    const isDetailOpen = document.getElementById('subject-detail-modal').classList.contains('open');

    if (isDetailOpen && currentSubjectDetailId) {
        launchGradeModal(currentSubjectDetailId);
    } else {
        document.getElementById('current-subject-id').value = "";
        document.getElementById('grade-subject-group').style.display = 'block';
        openModal('grade-modal');
    }
}

function promptPrediction() {
    const modal = document.getElementById('grade-modal');
    modal.classList.add('simulation-mode');
    modal.classList.remove('annotation-mode');
    document.getElementById('grade-value').style.display = 'block';
    document.getElementById('grade-annotation-select').style.display = 'none';
    document.getElementById('grade-label').innerText = "Voto Numerico (1 - 10)";
    document.getElementById('grade-modal-title').innerText = "Simula Valutazione (Previsione)";
    document.getElementById('btn-save-grade').innerText = "Applica ai Calcoli";
    document.getElementById('is-simulation-flag').value = "true";
    document.getElementById('current-subject-id').value = currentSubjectDetailId;
    openModal('grade-modal');
}

function openAnnotationModal() {
    const modal = document.getElementById('grade-modal');
    modal.classList.add('annotation-mode');
    modal.classList.remove('simulation-mode');
    document.getElementById('grade-value').style.display = 'none';
    document.getElementById('grade-annotation-select').style.display = 'block';
    document.getElementById('grade-graphic-display').style.display = 'flex';
    document.getElementById('grade-graphic-display').innerText = '-';
    document.getElementById('grade-graphic-display').className = 'grade-bubble g-red';
    document.getElementById('grade-annotation-select').value = '-';
    document.getElementById('grade-label').innerText = "Annotazione / Giudizio";
    document.getElementById('grade-modal-title').innerText = "Aggiungi Nota o Giudizio";
    document.getElementById('btn-save-grade').innerText = "Salva Nota";
    document.getElementById('is-simulation-flag').value = "false";
    document.getElementById('current-subject-id').value = currentSubjectDetailId;
    openModal('grade-modal');
}

function clearSimulationFromDetail() {
    simulateSubjectAvg(currentSubjectDetailId, null);
    const infoBox = document.getElementById('prediction-info-box');
    if(infoBox) infoBox.style.display = 'none';
    showToast("Simulazione rimossa.");
}

/**
 * Invia manualmente l'email di verifica all'utente corrente
 */
async function sendVerificationEmail() {
    if (!currentUser) return; // Aggiunto per coerenza
    try { await currentUser.sendEmailVerification(); showToast("Email di verifica inviata! Controlla la tua posta.", "success"); } 
    catch (error) { console.error("Errore invio verifica:", error); const msg = error.code === 'auth/too-many-requests' ? "Troppe richieste. Riprova più tardi." : "Errore durante l'invio."; showToast(msg, "error"); }
}


function openMediaCalculationModal() {
    const body = document.getElementById('media-breakdown-body');
    const formulaCont = document.getElementById('media-formula-summary');
    if (!body || !formulaCont) return;

    let rowsHtml = ''; // Aggiunto per coerenza
    let sumOfAvgs = 0;
    let subjectCount = 0;
    let chartData = [];

    schoolData.forEach(sub => {
        const fGrades = filterGradesByPeriod(sub.grades || []);
        const isPredicted = simulatedValues[sub.id] !== undefined;
        
        if (fGrades.length > 0 || isPredicted) {
            const { weightedSum, totalWeight } = calculateWeightedMetrics(fGrades);
            let subAvg = totalWeight > 0 ? (weightedSum / totalWeight) : 0;

            // Se c'è una simulazione, calcoliamo la media prevista per quella materia
            if (isPredicted) {
                subAvg = (weightedSum + simulatedValues[sub.id]) / (totalWeight + 1);
            }

            if (subAvg > 0) {
                sumOfAvgs += subAvg;
                subjectCount++;

                chartData.push({ name: sub.name, avg: subAvg, isPredicted });
                
                rowsHtml += `
                    <tr>
                        <td>
                            <div class="bold-text-blue">${sub.name}</div>
                            <span class="breakdown-math">${totalWeight > 0 ? `Σ(voti*peso) / ${totalWeight.toFixed(1)}` : 'Simulazione pura'}</span>
                        </td>
                        <td class="text-center">${fGrades.length}</td>
                        <td class="text-center">
                            <span class="scrutinio-pill-box ${subAvg >= 6 ? 'g-green' : (subAvg >= 5 ? 'g-orange' : 'g-red')}">
                                ${subAvg.toFixed(2)}
                            </span>
                        </td>
                        <td class="text-right">
                            <span class="status-pill ${isPredicted ? 'predicted' : 'actual'}">
                                ${isPredicted ? '📡 Simulato' : '✅ Reale'}
                            </span>
                        </td>
                    </tr>
                `;
            }
        }
    });

    body.innerHTML = rowsHtml || '<tr><td colspan="4" class="text-center">Nessun dato disponibile per il calcolo</td></tr>';
    
    if (subjectCount > 0) {
        const finalAvg = (sumOfAvgs / subjectCount).toFixed(2);
        formulaCont.innerHTML = `
            Media Totale = ${sumOfAvgs.toFixed(2)} (Somma Medie) / ${subjectCount} (Materie) = <span style="font-size: 18px; color: var(--primary-orange);">${finalAvg}</span>
        `;
        renderMediaBarChart(chartData);
    } else {
        formulaCont.innerHTML = "Dati insufficienti per generare la media.";
        const barCont = document.getElementById('media-bars-container');
        if (barCont) barCont.innerHTML = '';
    }
    openModal('media-calculation-modal');
}

function renderMediaBarChart(data) {
    const container = document.getElementById('media-bars-container');
    if (!container) return;
    
    // Ordiniamo le materie dalla media più alta alla più bassa per il grafico // Aggiunto per coerenza
    const sorted = [...data].sort((a, b) => b.avg - a.avg);
    
    let html = '<div class="bar-chart-wrapper">';
    sorted.forEach(item => {
        const color = item.avg >= 6 ? "#10b981" : (item.avg >= 5 ? "#f59e0b" : "#ef4444");
        const width = (item.avg / 10) * 100;
        
        html += `
            <div class="bar-row">
                <div class="bar-label" title="${item.name}">${item.name}</div>
                <div class="bar-track"> 
                    <div class="bar-target-line" style="left: 60%;"></div> <!-- Linea della sufficienza -->
                    <div class="bar-fill" style="width: ${width}%; background-color: ${color}; ${item.isPredicted ? 'opacity: 0.7; border: 1px dashed #fff;' : ''}"></div>
                </div>
                <div class="bar-value">${item.avg.toFixed(2)}</div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = `<h4 style="font-size:11px; color:#64748b; margin-bottom:12px; text-transform:uppercase;">Confronto Medie Materie</h4>` + html;
}

/**
 * Mostra istruzioni per l'installazione della PWA su iOS
 */
function showInstallInstructions() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        showToast("Per installare: tocca l'icona 'Condividi' (quadrato con freccia) in Safari e seleziona 'Aggiungi alla schermata Home'.", "success");
    } else {
        showToast("Usa il menu del browser per installare l'app sul tuo dispositivo.", "success");
    }
}

// Registrazione Service Worker per funzionalità App
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => {
                console.log('Service Worker registrato!', reg);
                // Forza il controllo degli aggiornamenti ad ogni caricamento
                reg.update();
                reg.onupdatefound = () => {
                    const installingWorker = reg.installing;
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            if (confirm("Nuova versione disponibile! Ricaricare?")) window.location.reload();
                        }
                    };
                };
            })
            .catch(err => console.log('Errore SW:', err));
    });
}