// --- GLOBAL VARIABLES ---
let currentPlan = {};
let pmcChartInstance = null;
let activityMap = null;
let globalHistoryData = [];
let currentCoachTone = "Empathetic but demanding elite endurance coach."; // NEW Tracker

// Simple toast notification function
function showToast(message, type = 'info') {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none';
        document.body.appendChild(toastContainer);
    }
    const toast = document.createElement('div');
    const bgColor = type === 'error' ? 'bg-red-500' : type === 'success' ? 'bg-green-500' : 'bg-theme-accent';
    toast.className = `${bgColor} text-white px-4 py-2 rounded shadow-lg opacity-0 transition-opacity duration-300 pointer-events-auto`;
    toast.innerText = message;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('opacity-0');
        toast.classList.add('opacity-100');
    });

    setTimeout(() => {
        toast.classList.remove('opacity-100');
        toast.classList.add('opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function getMonday(d) {
    d = new Date(d);
    var day = d.getDay(), diff = d.getDate() - day + (day == 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}
let viewingWeekStart = getMonday(new Date());

let globalMilestones = [];
let globalMetrics = [];

// --- METRICS UI LOGIC ---
function renderMetricsEditor() {
    const container = document.getElementById('metrics-container');
    if (globalMetrics.length === 0) {
        container.innerHTML = `<p class="text-xs text-theme-muted italic">No metrics recorded yet.</p>`;
        return;
    }
    container.innerHTML = globalMetrics.map((m, idx) => `
                <div class="flex items-center gap-2 md:gap-4 bg-theme-bg p-2 rounded border border-theme-border metric-row">
                    <input type="text" class="metric-key flex-1 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text font-bold" value="${m.metric}" placeholder="Metric (e.g. 5K PB)">
                    <input type="text" class="metric-val flex-1 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text" value="${m.value}" placeholder="Value (e.g. 19:30)">
                    <button onclick="removeMetricRow(${idx})" class="text-red-500 hover:text-red-700 font-bold px-2">✕</button>
                </div>
            `).join('');
}

function addMetricRow() {
    const rows = document.querySelectorAll('.metric-row');
    if (rows.length > 0) {
        globalMetrics = Array.from(rows).map((row) => ({
            metric: row.querySelector('.metric-key').value,
            value: row.querySelector('.metric-val').value
        }));
    }
    globalMetrics.push({ metric: '', value: '' });
    renderMetricsEditor();
}

function removeMetricRow(idx) {
    const rows = document.querySelectorAll('.metric-row');
    if (rows.length > 0) {
        globalMetrics = Array.from(rows).map((row) => ({
            metric: row.querySelector('.metric-key').value,
            value: row.querySelector('.metric-val').value
        }));
    }
    globalMetrics.splice(idx, 1);
    renderMetricsEditor();
}

// --- ONBOARDING METRICS UI LOGIC ---
let onboardMetrics = [];

function renderOnboardMetricsEditor() {
    const container = document.getElementById('onboard-metrics-container');
    if (onboardMetrics.length === 0) {
        container.innerHTML = `<p class="text-[10px] text-theme-muted italic">No metrics added yet.</p>`;
        return;
    }
    container.innerHTML = onboardMetrics.map((m, idx) => `
        <div class="flex items-center gap-2 onboard-metric-row">
            <input type="text" class="onboard-metric-key flex-1 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text font-bold focus:border-theme-accent outline-none" value="${m.metric}" placeholder="Metric (e.g. FTP, 5K PB)">
            <input type="text" class="onboard-metric-val flex-1 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text focus:border-theme-accent outline-none" value="${m.value}" placeholder="Value">
            <button onclick="removeOnboardMetricRow(${idx})" class="text-red-500 hover:text-red-700 font-bold px-2">✕</button>
        </div>
    `).join('');
}

function addOnboardMetricRow() {
    const rows = document.querySelectorAll('.onboard-metric-row');
    if (rows.length > 0) {
        onboardMetrics = Array.from(rows).map((row) => ({
            metric: row.querySelector('.onboard-metric-key').value,
            value: row.querySelector('.onboard-metric-val').value
        }));
    }
    onboardMetrics.push({ metric: '', value: '' });
    renderOnboardMetricsEditor();
}

function removeOnboardMetricRow(idx) {
    const rows = document.querySelectorAll('.onboard-metric-row');
    if (rows.length > 0) {
        onboardMetrics = Array.from(rows).map((row) => ({
            metric: row.querySelector('.onboard-metric-key').value,
            value: row.querySelector('.onboard-metric-val').value
        }));
    }
    onboardMetrics.splice(idx, 1);
    renderOnboardMetricsEditor();
}

async function saveMetrics() {
    const rows = document.querySelectorAll('.metric-row');
    const updated = Array.from(rows).map((row) => ({
        metric: row.querySelector('.metric-key').value.trim(),
        value: row.querySelector('.metric-val').value.trim()
    })).filter(m => m.metric && m.value);

    try {
        const res = await fetch('/api/user/metrics', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ metrics: updated })
        });
        if (res.ok) {
            const statusEl = document.getElementById('metrics-status');
            if (statusEl) {
                statusEl.classList.remove('hidden');
                setTimeout(() => statusEl.classList.add('hidden'), 3000);
            }
            loadMetrics();
        }
    } catch (e) { alert("Failed to save metrics."); }
}

async function loadMetrics() {
    try {
        const res = await fetch('/api/user/metrics', { headers: getAuthHeaders() });
        if (res.ok) {
            globalMetrics = await res.json();
            renderMetricsEditor();
        }
    } catch (e) { }
}

// --- MILESTONE UI LOGIC ---
function renderMilestoneEditor() {
    const container = document.getElementById('milestones-container');
    if (globalMilestones.length === 0) {
        container.innerHTML = `<p class="text-xs text-theme-muted italic">No races planned. The yellow target line and training phases will be hidden.</p>`;
        return;
    }

    container.innerHTML = globalMilestones.map((m, idx) => `
                <div class="flex items-center gap-2 md:gap-4 bg-theme-bg p-2 rounded border border-theme-border milestone-row">
                    <input type="radio" name="main_goal" value="${idx}" ${m.is_main ? 'checked' : ''} class="w-4 h-4 text-theme-accent accent-theme-accent cursor-pointer" title="Set as Main Goal">
                    <input type="date" class="ms-date w-32 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text" value="${m.date}">
                    <input type="text" class="ms-name flex-1 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text" value="${m.name}" placeholder="Race Name">
                    <input type="number" class="ms-ctl w-16 p-1.5 border border-theme-border rounded text-xs bg-theme-card text-theme-text text-right" value="${m.target_ctl}" placeholder="CTL">
                    <button onclick="removeMilestoneRow(${idx})" class="text-red-500 hover:text-red-700 font-bold px-2">✕</button>
                </div>
            `).join('');
}

function addMilestoneRow() {
    globalMilestones.push({ name: '', date: '', target_ctl: 50, is_main: globalMilestones.length === 0 });
    renderMilestoneEditor();
}

function removeMilestoneRow(idx) {
    globalMilestones.splice(idx, 1);
    renderMilestoneEditor();
}

async function saveMilestones() {
    const rows = document.querySelectorAll('.milestone-row');
    const updated = Array.from(rows).map((row, idx) => {
        return {
            is_main: row.querySelector('input[type="radio"]').checked,
            date: row.querySelector('.ms-date').value,
            name: row.querySelector('.ms-name').value,
            target_ctl: parseFloat(row.querySelector('.ms-ctl').value)
        };
    }).filter(m => m.date && m.name); // Drop empty rows

    try {
        const res = await fetch('/api/milestones', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ milestones: updated }) });
        if (res.ok) {
            alert("Calendar saved!");
            window.location.reload(); // Reload to redraw charts and macros
        }
    } catch (e) { alert("Failed to save calendar."); }
}

async function pushToGarmin(event) {
    const checkboxes = document.querySelectorAll('.garmin-sync-cb:checked');
    if (checkboxes.length === 0) return;

    // Gather the exact date & sport for each checked box
    const selectedWorkouts = Array.from(checkboxes).map(cb => ({
        date: cb.getAttribute('data-date'),
        sport: cb.getAttribute('data-sport')
    }));

    const btn = document.getElementById('garmin-sync-btn');
    const originalText = btn.innerText;
    btn.innerText = "Syncing...";
    btn.disabled = true;

    const msgEl = document.getElementById('garmin-sync-message');
    if (msgEl) {
        msgEl.innerText = "Syncing selected workouts... Please wait.";
        msgEl.classList.remove('hidden', 'text-red-500');
        msgEl.classList.add('text-theme-accent');
    }

    try {
        const res = await fetch('/api/sync-garmin', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ workouts: selectedWorkouts }) // <-- Sending the payload
        });
        const data = await res.json();

        if (res.ok) {
            if (msgEl) msgEl.innerText = data.message;
            // Uncheck boxes on success
            checkboxes.forEach(cb => cb.checked = false);
            toggleGarminBtn();
        } else {
            if (msgEl) {
                msgEl.innerText = "Error: " + data.error;
                msgEl.classList.replace('text-theme-accent', 'text-red-500');
            }
        }
    } catch (e) {
        if (msgEl) {
            msgEl.innerText = "Server Error while connecting to Garmin.";
            msgEl.classList.replace('text-theme-accent', 'text-red-500');
        }
    } finally {
        btn.innerText = originalText;
        // Button state will be handled by toggleGarminBtn() if boxes were cleared
        if (msgEl) setTimeout(() => msgEl.classList.add('hidden'), 5000);
    }
}

// --- AUTHENTICATION LOGIC ---
function getAuthHeaders() {
    const token = localStorage.getItem('nana_token');
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
}

let sseConnection = null;

function initSSE() {
    const token = localStorage.getItem('nana_token');
    if (!token) return;

    if (sseConnection) sseConnection.close();

    // Pass token in URL query parameter because EventSource doesn't support custom headers
    sseConnection = new EventSource(`/api/events?token=${token}`);

    sseConnection.addEventListener('sync_complete', (e) => {
        console.log("Real-time sync complete received:", e.data);
        // Silently refresh the dashboard data if the user is logged in
        if (document.getElementById('login-overlay').style.display === 'none') {
            fetchDashboardData();
        }
    });

    sseConnection.addEventListener('unread_message', (e) => {
        console.log("Real-time unread message received:", e.data);
        const data = JSON.parse(e.data);

        // Show notification bubble if not currently on the coach tab
        const coachTabHidden = document.getElementById('view-coach')?.classList.contains('hidden');
        if (coachTabHidden) {
            const badge = document.getElementById('unread-badge');
            if (badge) badge.classList.remove('hidden');
            // update lastMsgTime so reload keeps the badge
            localStorage.setItem('lastMsgTimestamp', Date.now());
        } else {
            // Already on Coach tab, reload the chat to show the new message
            loadChatHistory();
        }
    });

    sseConnection.onerror = (err) => {
        console.error("SSE Connection Error:", err);
        sseConnection.close();
        setTimeout(initSSE, 5000); // Reconnect after 5 seconds
    };
}

function checkLogin() {
    const token = localStorage.getItem('nana_token');
    if (token) {
        document.getElementById('login-overlay').style.display = 'none';
        loadSettings();
        buildDashboard();
        loadChatHistory();
        initSSE();
    } else {
        document.getElementById('login-overlay').style.display = 'flex';
    }
}

function toggleAuthMode(mode) {
    const err = document.getElementById('auth-error');
    err.classList.add('hidden');

    if (mode === 'register') {
        document.getElementById('form-login').classList.add('hidden');
        document.getElementById('form-register').classList.remove('hidden');
        document.getElementById('auth-title').innerText = "New Athlete";
        document.getElementById('auth-subtitle').innerText = "Create your Spark account.";
    } else {
        document.getElementById('form-register').classList.add('hidden');
        document.getElementById('form-login').classList.remove('hidden');
        document.getElementById('auth-title').innerText = "Welcome Back";
        document.getElementById('auth-subtitle').innerText = "Sign in to your training plan.";
    }
}

async function attemptAuth(action) {
    const errEl = document.getElementById('auth-error');
    errEl.classList.add('hidden');

    let url, payload;

    if (action === 'login') {
        url = '/api/auth/login';
        payload = {
            username: document.getElementById('login-user').value,
            password: document.getElementById('login-pass').value
        };
    } else {
        url = '/api/auth/register';
        payload = {
            username: document.getElementById('reg-user').value,
            password: document.getElementById('reg-pass').value
        };
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok) {
            if (action === 'login') {
                localStorage.setItem('nana_token', data.token);
                window.location.reload();
            } else {
                toggleAuthMode('login');
                document.getElementById('login-user').value = payload.username;
                errEl.innerText = "Account created! Please log in.";
                errEl.className = "text-theme-accent text-xs mt-4 block font-medium bg-theme-accent-soft p-2 rounded border border-theme-accent-border";
            }
        } else {
            errEl.innerText = data.error || "Authentication failed.";
            errEl.className = "text-red-500 text-xs mt-4 block font-medium bg-red-50 p-2 rounded border border-red-200";
        }
    } catch (e) {
        errEl.innerText = "Server connection error.";
        errEl.className = "text-red-500 text-xs mt-4 block font-medium bg-red-50 p-2 rounded border border-red-200";
    }
}

function logout() {
    localStorage.removeItem('nana_token');
    window.location.reload();
}

// --- SETTINGS LOGIC ---
async function loadSettings() {
    try {
        const res = await fetch('/api/user/settings', { headers: getAuthHeaders() });
        if (res.status === 401 || res.status === 403) return logout();

        const data = await res.json();

        // NEW: Admin Check
        // 1. Let's log the data to see exactly what we have to work with
        console.log("🕵️ Checking Admin Status for:", data);

        // 2. A more robust check: checks username, email, OR if you are user ID #1
        const isRutger = (data.username && data.username.toLowerCase() === 'rutger') ||
            (data.email && data.email.toLowerCase().includes('rutger')) ||
            (data.id === 1); // From your previous logs, you are likely User #1!

        if (isRutger) {
            console.log("✅ Admin verified! Unlocking admin features...");

            // Unhide the Admin Section in Settings
            const adminSection = document.getElementById('admin-settings-section');
            if (adminSection) {
                adminSection.classList.remove('hidden');
                loadAdminUsage();
            } else {
                console.error("❌ Could not find 'admin-settings-section' in the HTML!");
            }

            // Unhide the secret Admin-Only coach tone
            const select = document.getElementById('set-coach-tone');
            if (select && !select.querySelector('option[value*="madison"]')) {
                select.innerHTML += `<option value="Flirty, Horny, lewd, erotic, highly suggestive, a little bi-sexual, supportive, as if in a relationship, in the style of Madison Beer.">Coach Madison</option>`;
            }
        }

        currentCoachTone = data.coachTone || ''; // Save to global memory

        document.getElementById('set-coach-tone').value = data.coachTone || '';
        document.getElementById('set-athlete-context').value = data.athleteContext || '';
        document.getElementById('set-garmin-user').value = data.garminUsername || '';
        // --- ONBOARDING TRIGGER ---
        // In server.js, new users default to 'New athlete.'
        if (data.athleteContext === 'New athlete.') {
            const overlay = document.getElementById('onboarding-overlay');
            if (overlay) {
                overlay.classList.remove('hidden');
                overlay.classList.add('flex');
            }
        }
        if (data.hasGarmin) {
            const b = document.getElementById('garmin-status');
            b.innerText = "Connected";
            b.className = "text-[10px] font-bold px-2 py-1 rounded bg-theme-accent-soft text-theme-accent border border-theme-accent-border";
        }
        if (data.hasStrava) {
            const b = document.getElementById('strava-status');
            b.innerText = "Connected";
            b.className = "text-[10px] font-bold px-2 py-1 rounded bg-theme-accent-soft text-theme-accent border border-theme-accent-border";
        }

        // If user is connected, hide the banner and show the dashboard!
        if (data.hasGarmin || data.hasStrava) {
            const banner = document.getElementById('welcome-banner');
            const content = document.getElementById('dashboard-content');
            if (banner) banner.classList.add('hidden');
            if (content) content.classList.remove('hidden');
        }
        loadMetrics();
    } catch (e) { console.error("Failed to load settings."); }
}

async function saveSettings(type) {
    const statusEl = document.getElementById('settings-status');
    let url = `/api/user/settings/${type}`;
    let payload = {};

    if (type === 'coach') {
        payload = {
            coachTone: document.getElementById('set-coach-tone').value,
            athleteContext: document.getElementById('set-athlete-context').value
        };
    } else if (type === 'garmin') {
        payload = {
            garminUsername: document.getElementById('set-garmin-user').value,
            garminPassword: document.getElementById('set-garmin-pass').value
        };
    } else if (type === 'strava') {
        payload = {
            stravaRefreshToken: document.getElementById('set-strava-token').value
        };
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            // Show the status message
            statusEl.textContent = "Settings saved successfully!";
            statusEl.classList.remove('hidden', 'bg-red-50', 'text-red-600', 'border-red-200');
            statusEl.classList.add('bg-theme-accent-soft', 'text-theme-accent', 'border-theme-accent-border');
            statusEl.classList.remove('hidden');

            // Hide it after 5 seconds
            setTimeout(() => {
                statusEl.classList.add('hidden');
            }, 5000);

            loadSettings();
        } else {
            const err = await res.json();
            // Show error state
            statusEl.textContent = "Error: " + (err.error || "Failed to save.");
            statusEl.classList.remove('hidden', 'bg-theme-accent-soft', 'text-theme-accent', 'border-theme-accent-border');
            statusEl.classList.add('bg-red-50', 'text-red-600', 'border-red-200');
            statusEl.classList.remove('hidden');
        }
    } catch (e) {
        statusEl.textContent = "Server error. Please try again.";
        statusEl.classList.remove('hidden');
    }
}

async function forceStravaSync() {
    const msgEl = document.getElementById('strava-sync-message');
    msgEl.innerText = "Syncing with Strava...";
    msgEl.classList.remove('hidden');
    msgEl.className = "text-xs font-bold mt-3 text-theme-muted block animate-pulse";

    try {
        const res = await fetch('/api/sync-strava', { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();

        if (res.ok) {
            msgEl.innerText = data.message + " Refreshing dashboard...";
            msgEl.className = "text-xs font-bold mt-3 text-theme-accent block";
            setTimeout(() => window.location.reload(), 1500); // Reload to draw the charts
        } else {
            msgEl.innerText = data.error;
            msgEl.className = "text-xs font-bold mt-3 text-red-500 block";
        }
    } catch (e) {
        msgEl.innerText = "Network error connecting to server.";
        msgEl.className = "text-xs font-bold mt-3 text-red-500 block";
    }
}

// --- UI NAVIGATION ---
function updateUnreadBadge(latestMsgTime) {
    const lastViewed = parseInt(localStorage.getItem('lastChatViewTimestamp') || '0');
    const badge = document.getElementById('unread-badge');
    const coachTabHidden = document.getElementById('view-coach')?.classList.contains('hidden');

    if (latestMsgTime > lastViewed && coachTabHidden && badge) {
        badge.classList.remove('hidden');
    }
}

function switchTab(t) {
    // Safely toggle visibility to prevent missing ID crashes
    const views = ['dashboard', 'coach', 'settings', 'history', 'admin', 'physique'];
    views.forEach(view => {
        const el = document.getElementById(`view-${view}`);
        if (el) el.classList.toggle('hidden', t !== view);
    });

    if (t === 'coach') {
        localStorage.setItem('lastChatViewTimestamp', Date.now());
        const badge = document.getElementById('unread-badge');
        if (badge) badge.classList.add('hidden');
    }

    document.getElementById('current-tab-title').innerText = { 'dashboard': 'Dashboard', 'coach': 'AI Coach', 'settings': 'Athlete Profile', 'history': 'Log', 'physique': 'Physique & Recovery' }[t];

    views.forEach(tab => {
        const btn = document.getElementById(`nav-${tab}`);
        if (!btn) return;
        if (tab === t) {
            btn.classList.add('text-theme-accent-hover', 'bg-theme-accent-soft', 'border-theme-accent');
            btn.classList.remove('text-theme-muted', 'hover:bg-theme-bg', 'hover:text-theme-text', 'border-transparent');
        } else {
            btn.classList.remove('text-theme-accent-hover', 'bg-theme-accent-soft', 'border-theme-accent');
            btn.classList.add('text-theme-muted', 'hover:bg-theme-bg', 'hover:text-theme-text', 'border-transparent');
        }
    });

    if (t === 'history') loadHistory();
    if (t === 'physique') {
        loadPhysiqueLogs();
        loadNutritionProtocol();
    }
    if (t === 'coach') {
        loadChatHistory();
        setTimeout(() => {
            const chatWindow = document.getElementById('chat-window');
            if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
        }, 50);
    }
}

// 1. Sends the user to Strava's login screen
function connectStravaOAuth() {
    const clientId = '208765'; // Replace with your actual numeric Client ID
    // Redirects them back to your app after they click "Authorize"
    const redirectUri = encodeURIComponent(window.location.origin);
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=activity:read_all,activity:write`;

    window.location.href = authUrl;
}

// 2. Checks if Strava just sent them back with a code
async function checkStravaCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (code) {
        // Clear the URL so it looks clean
        window.history.replaceState({}, document.title, "/");

        // Make sure they are logged in before trading the code
        const token = localStorage.getItem('nana_token');
        if (!token) return;

        // Send the code to the new backend route
        try {
            const res = await fetch('/api/user/settings/strava-exchange', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ code })
            });

            if (res.ok) {
                alert("Strava successfully connected!");
                loadSettings(); // Refresh UI badges
            } else {
                alert("Strava connection failed. Please try again.");
            }
        } catch (e) {
            console.error(e);
        }
    }
}

// --- DASHBOARD HELPERS ---
function changeWeek(offset) {
    viewingWeekStart.setDate(viewingWeekStart.getDate() + (offset * 7));
    loadMicroPlan();
}

function resetChartZoom() {
    if (pmcChartInstance) pmcChartInstance.resetZoom();
}

function renderMacroPlan() {
    const macroBlock = document.getElementById('macro-block');

    // 1. Hide if no goals
    if (!globalMilestones || globalMilestones.length === 0) {
        if (macroBlock) macroBlock.classList.add('hidden');
        return;
    }

    // 2. Find the main A-Race (fallback to the last race if none selected)
    const mainRace = globalMilestones.find(m => m.is_main) || globalMilestones[globalMilestones.length - 1];

    if (macroBlock) macroBlock.classList.remove('hidden');

    const today = new Date();
    const raceDate = new Date(mainRace.date);
    const totalDays = 112;
    const planStartDate = new Date(raceDate);
    planStartDate.setDate(planStartDate.getDate() - totalDays);

    const taperDays = 14;
    const peakDays = 21;
    const buildDays = 28;
    const baseDays = totalDays - (taperDays + peakDays + buildDays);

    document.getElementById('phase-base').style.width = `${(baseDays / totalDays) * 100}%`;
    document.getElementById('phase-build').style.width = `${(buildDays / totalDays) * 100}%`;
    document.getElementById('phase-peak').style.width = `${(peakDays / totalDays) * 100}%`;
    document.getElementById('phase-taper').style.width = `${(taperDays / totalDays) * 100}%`;

    const daysRemaining = Math.ceil((raceDate - today) / (1000 * 60 * 60 * 24));

    const countdownEl = document.getElementById('macro-countdown');
    if (daysRemaining > 0) {
        countdownEl.innerText = `${daysRemaining} Days to ${mainRace.name}`;
        countdownEl.className = "text-[10px] md:text-xs font-mono text-theme-accent font-bold bg-theme-card px-2 py-1 rounded-md border border-theme-border shadow-sm";
    } else if (daysRemaining === 0) {
        countdownEl.innerText = "RACE DAY!";
        countdownEl.className = "text-[10px] md:text-xs font-mono text-white font-bold bg-theme-accent px-2 py-1 rounded-sm shadow-sm";
    } else {
        countdownEl.innerText = "RACE COMPLETED";
        countdownEl.className = "text-[10px] md:text-xs font-mono text-theme-muted font-bold bg-theme-card px-2 py-1 rounded-md border border-theme-border shadow-sm";
    }

    const daysElapsed = totalDays - daysRemaining;
    let percentElapsed = (daysElapsed / totalDays) * 100;
    if (percentElapsed < 0) percentElapsed = 0;
    if (percentElapsed > 100) percentElapsed = 100;

    setTimeout(() => {
        document.getElementById('today-marker').style.left = `${percentElapsed}%`;
        document.getElementById('macro-progress').style.width = `${percentElapsed}%`;
    }, 300);
}

function updateDailyReflection(currentCtl, currentAtl) {
    const todayStr = new Date().toISOString().split('T')[0];
    const tsb = currentCtl - currentAtl;
    let quote = "";

    if (tsb < -30) quote = "You are in the red. High fatigue detected. Prioritize active recovery and fueling today, or risk overtraining.";
    else if (tsb >= -30 && tsb < -10) quote = "Optimal training zone! You are accumulating fatigue and your fitness is increasing exactly according to plan. Keep pushing.";
    else if (tsb >= -10 && tsb <= 5) quote = "You are in a transitional phase. You are shedding fatigue, but you need to push a bit harder to trigger new fitness adaptations.";
    else if (tsb > 5 && tsb <= 25) quote = "You are fresh and primed! Your body is fully recovered, highly fit, and ready for a race or a massive test effort.";
    else quote = "Detraining warning. Your fatigue is very low, meaning you need to consistently increase your volume to recover your fitness level.";

    const refEl = document.getElementById('daily-reflection');
    if (refEl) refEl.innerText = quote;
}

function estimateWorkoutDetails(sport, desc, tss) {
    if (!tss || tss === 0 || sport === 'Rest') return '<span class="text-theme-muted">Rest</span>';
    return ''; // Hide estimated TSS time and zone per user request
}

function getWeatherEmoji(code) {
    if (code === 0) return '☀️'; if (code >= 1 && code <= 3) return '⛅'; if (code >= 45 && code <= 48) return '🌫️'; if (code >= 51 && code <= 67) return '🌧️'; if (code >= 71 && code <= 77) return '❄️'; if (code >= 80 && code <= 82) return '🌦️'; if (code >= 95) return '⛈️'; return '☁️';
}

// --- CORE DATA FUNCTIONS ---
async function buildDashboard() {
    try {
        // 1. Fetch TSS, Weight, Milestones, Briefing, and Physique
        const [tssRes, weightRes, msRes, briefRes, physRes] = await Promise.all([
            fetch('/api/dashboard-data', { headers: getAuthHeaders() }),
            fetch('/api/weight', { headers: getAuthHeaders() }),
            fetch('/api/milestones', { headers: getAuthHeaders() }),
            fetch('/api/dashboard/briefing', { headers: getAuthHeaders() }),
            fetch('/api/physique', { headers: getAuthHeaders() })
        ]);

        if (!tssRes.ok || !weightRes.ok) return; // Prevent crash if backend is not ready

        const data = await tssRes.json();
        const weightData = await weightRes.json();

        // 2. Store milestones globally for charts & editor
        globalMilestones = msRes.ok ? await msRes.json() : [];
        renderMilestoneEditor(); // Populate the settings tab

        // 2.5 Process Daily Briefing
        const deskReflection = document.getElementById('daily-reflection');
        const deskAvatar = document.getElementById('desk-coach-avatar');
        if (briefRes && briefRes.ok) {
            const briefData = await briefRes.json();
            if (briefData && briefData.briefing && briefData.briefing.content) {
                if (deskAvatar) deskAvatar.src = getCoachAvatar(briefData.briefing.mood || 'default');
                if (deskReflection) {
                    let formattedContent = briefData.briefing.content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    formattedContent = formattedContent.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<img src="$2" alt="$1" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full md:w-3/4 rounded-lg my-2 border border-theme-border shadow-sm">');
                    deskReflection.innerHTML = formattedContent;
                }
            } else {
                if (deskReflection) deskReflection.innerHTML = "<span class='text-theme-muted italic'>Checking in with Coach...</span>";
                if (deskAvatar) deskAvatar.src = getCoachAvatar('default');
                // No briefing today, trigger one
                triggerProactiveCheckin();
            }
        }

        // 3. Process Weight & Biometrics Table
        if (weightData && weightData.length > 0) {
            const sortedData = [...weightData].sort((a, b) => new Date(b.date) - new Date(a.date));
            const latest = sortedData[0];
            document.getElementById('latest-weight-metric').innerHTML = `${latest.weight_kg.toFixed(1)} <span class="text-sm text-theme-muted">kg</span>`;

            // Weight Trend (vs 7 days ago)
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() - 7);
            const targetDateStr = targetDate.toISOString().split('T')[0];

            let pastWeight = null;
            for (let w of sortedData) {
                if (w.date <= targetDateStr) {
                    pastWeight = w.weight_kg;
                    break;
                }
            }
            const weightTrendEl = document.getElementById('weight-trend');
            if (weightTrendEl && pastWeight) {
                let diff = latest.weight_kg - pastWeight;
                if (Math.abs(diff) < 0.2) {
                    weightTrendEl.innerHTML = `<span class="text-theme-muted">~</span>`;
                } else if (diff > 0) {
                    weightTrendEl.innerHTML = `<span class="text-red-500">↑${Math.abs(diff).toFixed(1)}</span>`;
                } else {
                    weightTrendEl.innerHTML = `<span class="text-green-500">↓${Math.abs(diff).toFixed(1)}</span>`;
                }
            } else if (weightTrendEl) {
                weightTrendEl.innerHTML = "";
            }

            let bioHtml = '';
            sortedData.slice(0, 10).forEach(w => {
                bioHtml += `<tr class="hover:bg-theme-bg transition">
                            <td class="p-3 md:p-4 text-theme-text">${w.date}</td>
                            <td class="p-3 md:p-4 font-mono text-theme-text text-right">${w.weight_kg ? w.weight_kg.toFixed(1) : '--'}</td>
                            <td class="p-3 md:p-4 font-mono text-theme-muted text-right">${w.body_fat_percent ? w.body_fat_percent.toFixed(1) : '--'}</td>                            
                        </tr>`;
            });
            const tbody = document.getElementById('biometrics-table-body');
            if (tbody) {
                tbody.innerHTML = bioHtml;
            }
        }

        // 4. Prepare dictionaries and set start date
        const tssDict = {};
        data.forEach(d => {
            tssDict[d.date] = (tssDict[d.date] || 0) + d.daily_tss;
        });
        const weightMap = Object.fromEntries(weightData.map(w => [w.date, w.weight_kg]));

        let minTssDate = data.length > 0 ? data[0].date : new Date().toISOString().split('T')[0];
        let minWeightDate = weightData.length > 0 ? weightData[0].date : new Date().toISOString().split('T')[0];
        let startDateStr = minTssDate < minWeightDate ? minTssDate : minWeightDate;

        let ctl = 0, atl = 0, d = new Date(startDateStr);
        const today = new Date();
        const dates = [], ctlData = [], atlData = [], tsbData = [], weightPlot = [], targetData = [], eventMarkerData = [];

        // 5. Loop 1: Calculate historical Form, Fitness, and Fatigue up to TODAY
        while (d <= today) {
            let str = d.toISOString().split('T')[0];
            let tss = tssDict[str] || 0;

            // Standard rolling averages (CTL = 42 days, ATL = 7 days)
            ctl += (tss - ctl) / 42;
            atl += (tss - atl) / 7;

            dates.push(str);
            ctlData.push(ctl);
            atlData.push(atl);
            tsbData.push(ctl - atl);
            weightPlot.push(weightMap[str] || null);

            // We don't draw the target line in the past, so push nulls
            targetData.push(null);
            eventMarkerData.push(null);
            d.setDate(d.getDate() + 1);
        }

        // Update Top Dashboard Metrics
        document.getElementById('ctl-metric').innerText = Math.round(ctl * 10) / 10;
        document.getElementById('atl-metric').innerText = Math.round(atl * 10) / 10;

        // Subtitles for CTL and ATL/TSB
        let tsb = ctl - atl;
        document.getElementById('ctl-subtitle').innerText = "Aerobic Base";

        const atlSub = document.getElementById('atl-subtitle');
        if (tsb < -30) { atlSub.innerText = "Overreaching"; atlSub.className = "text-[10px] text-red-500 mt-1 uppercase tracking-wider h-3"; }
        else if (tsb < -10) { atlSub.innerText = "Optimal Training"; atlSub.className = "text-[10px] text-theme-muted mt-1 uppercase tracking-wider h-3"; }
        else if (tsb < 5) { atlSub.innerText = "Maintaining"; atlSub.className = "text-[10px] text-theme-muted mt-1 uppercase tracking-wider h-3"; }
        else if (tsb < 25) { atlSub.innerText = "Fresh / Tapering"; atlSub.className = "text-[10px] text-theme-accent mt-1 uppercase tracking-wider h-3"; }
        else { atlSub.innerText = "Detraining"; atlSub.className = "text-[10px] text-amber-500 mt-1 uppercase tracking-wider h-3"; }

        // Calculate Readiness Score
        let readiness = 50; // Base score
        // Form (TSB) contribution: bounded [-20, +20]
        let tsbContrib = Math.max(-20, Math.min(20, tsb * 0.5));
        readiness += tsbContrib;

        if (physRes && physRes.ok) {
            const physData = await physRes.json();
            if (physData && physData.length > 0) {
                const latestPhys = physData[0]; // Already sorted descending by backend
                const todayStr = new Date().toISOString().split('T')[0];
                const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

                // Apply sleep/fatigue if logged today or yesterday
                if (latestPhys.date === todayStr || latestPhys.date === yesterdayStr) {
                    if (latestPhys.sleep_quality) readiness += (latestPhys.sleep_quality - 3) * 10;
                    if (latestPhys.fatigue_level) readiness -= (latestPhys.fatigue_level - 3) * 10;
                }
            }
        }

        readiness = Math.max(0, Math.min(100, Math.round(readiness)));
        const readinessEl = document.getElementById('readiness-metric');
        const readinessSub = document.getElementById('readiness-subtitle');
        if (readinessEl) {
            readinessEl.innerText = readiness;
            if (readiness < 40) {
                readinessEl.className = "text-2xl md:text-4xl font-semibold text-red-500 tracking-tight";
                if (readinessSub) { readinessSub.innerText = "Need Recovery"; readinessSub.className = "text-[10px] text-red-500/70 mt-1 uppercase tracking-wider h-3"; }
            } else if (readiness < 70) {
                readinessEl.className = "text-2xl md:text-4xl font-semibold text-amber-500 tracking-tight";
                if (readinessSub) { readinessSub.innerText = "Adequate"; readinessSub.className = "text-[10px] text-amber-500/70 mt-1 uppercase tracking-wider h-3"; }
            } else {
                readinessEl.className = "text-2xl md:text-4xl font-semibold text-green-500 tracking-tight";
                if (readinessSub) { readinessSub.innerText = "Prime Condition"; readinessSub.className = "text-[10px] text-green-500/70 mt-1 uppercase tracking-wider h-3"; }
            }

            const rSlider = document.getElementById('readiness-slider-container');
            const rMarker = document.getElementById('readiness-slider-marker');
            if (rSlider && rMarker) {
                rSlider.classList.remove('hidden');
                rMarker.style.left = `${readiness}%`;
            }
        }

        const fSlider = document.getElementById('fatigue-slider-container');
        const fMarker = document.getElementById('fatigue-slider-marker');
        if (fSlider && fMarker) {
            fSlider.classList.remove('hidden');
            // Map TSB (-40 to +20) to 0-100%
            let tsbPercent = Math.min(100, Math.max(0, ((tsb + 40) / 60) * 100));
            fMarker.style.left = `${tsbPercent}%`;
        }

        // --- TRENDS FOR CTL, ATL, READINESS ---
        let idx7 = Math.max(0, dates.length - 8);
        if (dates.length > 0) {
            let ctl7 = ctlData[idx7] || ctl;
            let atl7 = atlData[idx7] || atl;
            let tsb7 = ctl7 - atl7;
            let readiness7 = 50 + Math.max(-20, Math.min(20, tsb7 * 0.5));

            let ctlTrendEl = document.getElementById('ctl-trend');
            if (ctlTrendEl) {
                let diff = ctl - ctl7;
                if (Math.abs(diff) < 1) ctlTrendEl.innerHTML = `<span class="text-theme-muted">~</span>`;
                else if (diff > 0) ctlTrendEl.innerHTML = `<span class="text-green-500">↑${Math.abs(diff).toFixed(0)}</span>`;
                else ctlTrendEl.innerHTML = `<span class="text-red-500">↓${Math.abs(diff).toFixed(0)}</span>`;
            }

            let atlTrendEl = document.getElementById('atl-trend');
            if (atlTrendEl) {
                let diff = atl - atl7;
                if (Math.abs(diff) < 1) atlTrendEl.innerHTML = `<span class="text-theme-muted">~</span>`;
                else if (diff > 0) atlTrendEl.innerHTML = `<span class="text-amber-500">↑${Math.abs(diff).toFixed(0)}</span>`;
                else atlTrendEl.innerHTML = `<span class="text-green-500">↓${Math.abs(diff).toFixed(0)}</span>`;
            }

            let readTrendEl = document.getElementById('readiness-trend');
            if (readTrendEl) {
                let diff = readiness - readiness7;
                if (Math.abs(diff) < 2) readTrendEl.innerHTML = `<span class="text-theme-muted">~</span>`;
                else if (diff > 0) readTrendEl.innerHTML = `<span class="text-green-500">↑${Math.abs(diff).toFixed(0)}</span>`;
                else readTrendEl.innerHTML = `<span class="text-red-500">↓${Math.abs(diff).toFixed(0)}</span>`;
            }
        }

        // --- SPARKLINES ---
        const sparkOptions = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
            layout: { padding: 0 },
            elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } }
        };

        const sparkDates = dates.slice(-30);

        ['fitness', 'fatigue', 'readiness', 'weight'].forEach(metric => {
            const canvas = document.getElementById(`sparkline-${metric}`);
            if (canvas) {
                if (window[`sparkline_${metric}`]) window[`sparkline_${metric}`].destroy();
                let sparkData = [];
                let color = '#0ea5e9';
                if (metric === 'fitness') { sparkData = ctlData.slice(-30); color = '#0ea5e9'; }
                if (metric === 'fatigue') { sparkData = atlData.slice(-30); color = '#f43f5e'; }
                if (metric === 'readiness') {
                    sparkData = tsbData.slice(-30).map(t => 50 + Math.max(-20, Math.min(20, t * 0.5)));
                    color = '#10b981';
                }
                if (metric === 'weight') {
                    // Need to filter out nulls for a clean sparkline or rely on spanGaps
                    sparkData = weightPlot.slice(-30);
                    color = '#8b5cf6';
                }

                window[`sparkline_${metric}`] = new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: { labels: sparkDates, datasets: [{ data: sparkData, borderColor: color, fill: false, spanGaps: true }] },
                    options: sparkOptions
                });
            }
        });

        updateDailyReflection(ctl, atl);

        // 6. Loop 2: Dynamic Target Line & Future Projection
        let lastDate = new Date();

        if (globalMilestones.length > 0) {
            // Set chart end date to 7 days past the final milestone
            lastDate = new Date(globalMilestones[globalMilestones.length - 1].date);
            lastDate.setDate(lastDate.getDate() + 7);

            // Map points starting from today's actual CTL
            let controlPoints = [
                { date: new Date(today.toISOString().split('T')[0]), ctl: ctl },
                ...globalMilestones.map(m => ({ date: new Date(m.date), ctl: m.target_ctl }))
            ].sort((a, b) => a.date - b.date);

            let currentIdx = 0;

            while (d <= lastDate) {
                let str = d.toISOString().split('T')[0];

                // Push empty data for actuals since this is the future
                dates.push(str);
                ctlData.push(null);
                atlData.push(null);
                tsbData.push(null);
                weightPlot.push(weightMap[str] || null);

                // Linear interpolation for the target line
                while (currentIdx < controlPoints.length - 1 && d > controlPoints[currentIdx + 1].date) currentIdx++;
                let p1 = controlPoints[currentIdx], p2 = controlPoints[currentIdx + 1] || p1, targetCtl = p1.ctl;
                if (p1.date < p2.date) {
                    targetCtl = p1.ctl + ((p2.ctl - p1.ctl) * ((d - p1.date) / (p2.date - p1.date)));
                }

                targetData.push(targetCtl);
                eventMarkerData.push(globalMilestones.find(m => m.date === str) ? targetCtl : null);
                d.setDate(d.getDate() + 1);
            }
        }

        // --- GOAL PROGRESS WIDGET ---
        const goalWidget = document.getElementById('goal-progress-widget');
        if (globalMilestones.length > 0 && goalWidget) {
            goalWidget.classList.remove('hidden');
            let mainRace = globalMilestones[globalMilestones.length - 1];
            let targetCtl = mainRace.target_ctl;
            let daysOut = Math.max(0, Math.round((new Date(mainRace.date) - today) / (1000 * 60 * 60 * 24)));
            document.getElementById('goal-days-out').innerText = `${daysOut} days out`;
            document.getElementById('goal-now-text').innerHTML = `Now &middot; ${Math.round(ctl)} CTL`;
            document.getElementById('goal-target-text').innerHTML = `Target &middot; ${targetCtl} CTL`;

            let percent = Math.min(100, Math.max(0, (ctl / targetCtl) * 100));
            document.getElementById('goal-progress-bar').style.width = `${percent}%`;

            let fourteenDaysAgoStr = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
            let pastDateIndex = dates.findIndex(dStr => dStr === fourteenDaysAgoStr);
            let ctl14 = pastDateIndex !== -1 ? ctlData[pastDateIndex] : (ctlData[0] || ctl);
            let rampRateWeekly = ((ctl - ctl14) / 14) * 7;
            let projectedCtl = ctl + (rampRateWeekly * (daysOut / 7));

            let projTextEl = document.getElementById('goal-projection-text');
            if (daysOut === 0) {
                projTextEl.innerHTML = `Race day is here! Good luck!`;
                projTextEl.className = "text-[10px] md:text-xs text-theme-accent font-medium leading-relaxed";
            } else if (rampRateWeekly <= 0.1) {
                projTextEl.innerHTML = `You are not currently building fitness. Start training consistently to project your race day CTL.`;
                projTextEl.className = "text-[10px] md:text-xs text-amber-500 font-medium leading-relaxed";
            } else {
                projTextEl.innerHTML = `Building at +${rampRateWeekly.toFixed(1)} CTL/wk. Projected race day fitness: <strong class="text-theme-text">${Math.round(projectedCtl)} CTL</strong>.`;
                if (projectedCtl >= targetCtl) {
                    projTextEl.className = "text-[10px] md:text-xs text-green-500 font-medium leading-relaxed";
                } else {
                    projTextEl.className = "text-[10px] md:text-xs text-theme-accent font-medium leading-relaxed";
                }
            }
        } else if (goalWidget) {
            goalWidget.classList.add('hidden');
        }

        // 7. Render Chart.js
        if (pmcChartInstance) pmcChartInstance.destroy();
        const canvas = document.getElementById('pmcChart');

        if (canvas) {
            pmcChartInstance = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels: dates,
                    datasets: [
                        { label: 'Form', data: tsbData, type: 'bar', backgroundColor: ctx => ctx.raw > 0 ? 'rgba(250, 204, 21, 0.4)' : 'rgba(239, 68, 68, 0.4)', yAxisID: 'y' },
                        { label: 'Fitness', data: ctlData, borderColor: '#0ea5e9', borderWidth: 2, tension: 0.4, pointRadius: 0, yAxisID: 'y' },
                        { label: 'Fatigue', data: atlData, borderColor: '#f43f5e', borderDash: [5, 5], borderWidth: 1.5, tension: 0.4, pointRadius: 0, yAxisID: 'y' },
                        { label: 'Target', data: targetData, borderColor: '#f59e0b', borderDash: [6, 4], borderWidth: 2, tension: 0, pointRadius: 0, yAxisID: 'y' },
                        { label: 'Milestone', data: eventMarkerData, type: 'line', showLine: false, pointStyle: 'star', pointBackgroundColor: '#f59e0b', pointBorderColor: '#d97706', pointRadius: 10, pointHoverRadius: 12, yAxisID: 'y' }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    scales: {
                        y: { type: 'linear', position: 'left', grid: { color: 'rgba(156, 163, 175, 0.2)' }, ticks: { color: '#9ca3af', font: { size: 10 } } },
                        x: {
                            grid: { display: false },
                            ticks: { maxTicksLimit: 6, color: '#9ca3af', font: { size: 10 } },
                            min: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                            max: new Date().toISOString().split('T')[0]
                        }
                    },
                    plugins: {
                        legend: { position: 'bottom', labels: { color: '#9ca3af', usePointStyle: true, boxWidth: 6, font: { size: 11 } } },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    // Check dynamic global milestones for the tooltip text
                                    if (context.dataset.label === 'Milestone') {
                                        let ms = globalMilestones.find(m => m.date === context.label);
                                        if (ms) return `🏁 ${ms.name}`;
                                    }
                                    return context.dataset.label + ': ' + (typeof context.raw === 'number' ? Math.round(context.raw * 10) / 10 : context.raw);
                                }
                            }
                        },
                        zoom: { pan: { enabled: true, mode: 'x', modifierKey: 'ctrl' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } }
                    }
                }
            });
        }
    } catch (e) {
        console.error("Dashboard Build Error:", e);
    }

    // 8. Fire dependent modules
    loadMicroPlan();
    renderMacroPlan();
}

async function loadMicroPlan() {
    try {
        const [planRes, tssRes, weatherRes] = await Promise.all([
            fetch('/api/micro-plan', { headers: getAuthHeaders(), cache: 'no-store' }),
            fetch('/api/dashboard-data', { headers: getAuthHeaders(), cache: 'no-store' }),
            fetch('https://api.open-meteo.com/v1/forecast?latitude=52.3676&longitude=4.9041&daily=weather_code,temperature_2m_max,precipitation_sum&timezone=Europe%2FAmsterdam')
        ]);
        if (!planRes.ok || !tssRes.ok) return;

        const data = await planRes.json();
        const actualData = await tssRes.json();
        const weatherObj = await weatherRes.json();

        // 1. Group workouts into arrays by date (Prevents Overwriting!)
        currentPlan = {}; // Update global variable instead of shadowing
        data.forEach(d => {
            if (!currentPlan[d.date]) currentPlan[d.date] = [];
            currentPlan[d.date].push(d);
        });

        const actualTssMap = {};
        actualData.forEach(d => {
            actualTssMap[`${d.date}_${d.sport_type}`] = Math.round(d.daily_tss);
        });
        const weatherMap = {};
        if (weatherObj && weatherObj.daily && weatherObj.daily.time) {
            weatherObj.daily.time.forEach((wDate, idx) => {
                weatherMap[wDate] = {
                    temp: Math.round(weatherObj.daily.temperature_2m_max[idx]),
                    precip: weatherObj.daily.precipitation_sum[idx],
                    emoji: getWeatherEmoji(weatherObj.daily.weather_code[idx])
                };
            });
        }

        renderQuickActions(currentPlan, actualTssMap);

        const container = document.getElementById('micro-plan-container');
        if (!container) return;

        // Make the container a grid
        container.className = "grid grid-cols-1 md:grid-cols-7 gap-2 w-full";
        container.innerHTML = '';

        let weekEnd = new Date(viewingWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const opts = { month: 'short', day: 'numeric' };
        document.getElementById('week-range-label').innerText = `${viewingWeekStart.toLocaleDateString('en-US', opts)} - ${weekEnd.toLocaleDateString('en-US', opts)}`;

        let html = '';
        let todayStr = new Date().toISOString().split('T')[0];

        // 2. Loop through all 7 days of the week view
        for (let i = 0; i < 7; i++) {
            let d = new Date(viewingWeekStart);
            d.setDate(d.getDate() + i);
            let dateStr = d.toISOString().split('T')[0];
            let dayName = d.toLocaleDateString('en-US', { weekday: 'short' });

            // Get array of workouts, or default to Rest if empty
            let workoutsForDay = currentPlan[dateStr] || [{ sport: 'Rest', description: 'Active recovery', target_tss: 0, details: '' }];

            let isToday = (dateStr === todayStr);

            // Open Day Container
            html += `<div id="row-${dateStr}" class="flex flex-col bg-theme-card border ${isToday ? 'border-theme-accent ring-1 ring-theme-accent/50' : 'border-theme-border'} rounded-lg overflow-hidden h-full min-h-[150px]">`;

            // Header for the day
            html += `<div class="bg-theme-bg/50 px-3 py-2 border-b border-theme-border flex justify-between items-center">`;
            html += `<div class="flex flex-col"><span class="text-[10px] uppercase font-bold text-theme-muted tracking-wider">${dayName}</span><span class="text-xs font-medium text-theme-text">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div>`;

            // Weather
            if (weatherMap[dateStr]) {
                const w = weatherMap[dateStr];
                html += `<div class="text-right flex flex-col items-end leading-none"><span class="text-sm" title="${w.temp}°C">${w.emoji}</span><span class="text-[9px] font-mono text-theme-muted mt-1">${w.temp}°C</span></div>`;
            }
            html += `</div>`; // End Header

            // Body for workouts
            html += `<div class="p-2 flex flex-col gap-2 flex-grow">`;

            workoutsForDay.forEach((p, wIdx) => {
                let actualTss = actualTssMap[`${dateStr}_${p.sport}`] || 0;

                // Color coding
                let sportColor = "bg-gray-500/10 border-gray-500/20 text-gray-500";
                if (p.sport === 'Run') sportColor = "bg-red-500/10 border-red-500/20 text-red-500";
                else if (p.sport === 'Bike') sportColor = "bg-green-500/10 border-green-500/20 text-green-500";
                else if (p.sport === 'Swim') sportColor = "bg-blue-500/10 border-blue-500/20 text-blue-500";
                else if (p.sport === 'Strength') sportColor = "bg-purple-500/10 border-purple-500/20 text-purple-500";

                const isStructured = p.steps_json && p.steps_json !== '[]' && p.steps_json !== 'null';
                const pJson = encodeURIComponent(JSON.stringify(p)).replace(/'/g, "%27");

                html += `
                <div class="relative group p-2 rounded-md border ${sportColor} cursor-pointer hover:shadow-sm transition flex flex-col" onclick="openEditWorkoutModal('${pJson}', '${dateStr}')">
                    <div class="flex justify-between items-start mb-1">
                        <span class="text-[10px] font-bold uppercase tracking-wider">${p.sport}</span>
                        <span class="text-[9px] font-mono opacity-80">${actualTss > 0 ? actualTss + '/' : ''}${p.target_tss || 0} TSS</span>
                    </div>
                    <div class="text-xs font-medium text-theme-text line-clamp-2 leading-tight">${p.description || 'Rest Day'}</div>
                    <div class="mt-2 text-[9px] opacity-70 flex justify-between items-end">
                        <span class="truncate pr-2">${isStructured ? 'Structured' : 'Basic'}</span>
                        ${p.sport !== 'Rest' && dateStr >= todayStr ? `
                        <button onclick="event.stopPropagation(); syncSingleToGarmin(${p.id || null}, '${dateStr}', '${p.sport}')" class="p-1 rounded hover:bg-black/10 transition" title="Send to Garmin">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                        </button>` : ''}
                    </div>
                </div>`;
            });

            // Add workout button
            html += `
                <button onclick="openEditWorkoutModal(null, '${dateStr}')" class="mt-auto py-1.5 border border-dashed border-theme-border rounded-md text-theme-muted text-[10px] font-medium hover:text-theme-accent hover:border-theme-accent transition flex items-center justify-center gap-1 w-full">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> Add
                </button>
            `;

            html += `</div></div>`; // End body and day container
        }
        container.innerHTML = html;
    } catch (e) { console.error("Micro Plan Load Error:", e); }
}

// --- NEW EDIT WORKOUT MODAL ---

let wbCurrentWorkoutId = null;
let wbCurrentDateStr = '';
let wbSteps = [];

function openEditWorkoutModal(workoutData, dateStr) {
    wbCurrentDateStr = dateStr;
    const isNew = !workoutData;

    if (isNew) {
        wbCurrentWorkoutId = null;
        document.getElementById('edit-workout-date').value = dateStr;
        document.getElementById('edit-workout-sport').value = 'Run';
        document.getElementById('edit-workout-desc').value = '';
        wbSteps = [];
        document.getElementById('btn-edit-workout-delete').style.display = 'none';
        document.getElementById('btn-edit-workout-garmin').style.display = 'none';
    } else {
        const p = typeof workoutData === 'string' ? JSON.parse(decodeURIComponent(workoutData)) : workoutData;
        wbCurrentWorkoutId = p.id;
        document.getElementById('edit-workout-date').value = p.date || dateStr;
        document.getElementById('edit-workout-sport').value = p.sport;
        document.getElementById('edit-workout-desc').value = p.description || '';
        document.getElementById('edit-workout-tss').value = p.target_tss || 0;

        try {
            wbSteps = (p.steps_json && p.steps_json !== 'null') ? JSON.parse(p.steps_json) : [];
        } catch (e) {
            wbSteps = [];
        }
        if (p.id) {
            document.getElementById('btn-edit-workout-delete').style.display = 'block';
            document.getElementById('btn-edit-workout-garmin').style.display = p.sport !== 'Rest' ? 'flex' : 'none';
        } else {
            document.getElementById('btn-edit-workout-delete').style.display = 'none';
            document.getElementById('btn-edit-workout-garmin').style.display = 'none';
        }
    }

    // Add event listener to sport to re-render steps (for strength)
    document.getElementById('edit-workout-sport').onchange = () => { renderWbSteps(); };

    renderWbSteps();

    const modal = document.getElementById('edit-workout-modal');
    const content = document.getElementById('edit-workout-modal-content');
    modal.classList.remove('hidden');
    // Force reflow
    void modal.offsetWidth;
    modal.classList.remove('opacity-0');
    content.classList.remove('translate-y-full', 'md:scale-95');
    content.classList.add('translate-y-0', 'md:scale-100');
}

function closeEditWorkoutModal() {
    const modal = document.getElementById('edit-workout-modal');
    const content = document.getElementById('edit-workout-modal-content');

    modal.classList.add('opacity-0');
    content.classList.remove('translate-y-0', 'md:scale-100');
    content.classList.add('translate-y-full', 'md:scale-95');

    // Wait for transition to finish
    setTimeout(() => {
        modal.classList.add('hidden');
        wbCurrentWorkoutId = null;
        document.getElementById('edit-workout-desc').value = '';
    }, 300);
}

function calculateWbTss() {
    let totalMins = 0;
    wbSteps.forEach(s => {
        if (s.type === 'repeat') {
            let repeatMins = 0;
            (s.steps || []).forEach(sub => {
                if (sub.condition_type === 'time') repeatMins += Number(sub.condition_value) || 0;
            });
            totalMins += repeatMins * (s.iterations || 1);
        } else {
            if (s.condition_type === 'time') totalMins += Number(s.condition_value) || 0;
        }
    });
    const tssInput = document.getElementById('edit-workout-tss');
    if (totalMins > 0) {
        // Roughly 1 TSS per minute as a generic estimate
        tssInput.value = Math.round(totalMins * 1.0);
    } else {
        tssInput.value = '';
    }
}

// Workout Builder Logic
function wbAddStep(type) {
    const isStrength = document.getElementById('edit-workout-sport').value === 'Strength';
    const step = isStrength ?
        { type: type, condition_type: 'reps', condition_value: 10, target_type: 'no.target', weight: 0, exerciseName: '' } :
        { type: type, condition_type: 'time', condition_value: 5, target_type: 'no.target' };
    wbSteps.push(step);
    renderWbSteps();
}

function wbAddRepeat() {
    const isStrength = document.getElementById('edit-workout-sport').value === 'Strength';
    const step = {
        type: 'repeat', iterations: 3, steps: [
            isStrength ?
                { type: 'interval', condition_type: 'reps', condition_value: 10, target_type: 'no.target', weight: 0, exerciseName: '' } :
                { type: 'interval', condition_type: 'time', condition_value: 5, target_type: 'no.target' },
            { type: 'recovery', condition_type: 'time', condition_value: 2, target_type: 'no.target' }
        ]
    };
    wbSteps.push(step);
    renderWbSteps();
}

function wbRemoveStep(idx, subIdx = null) {
    if (subIdx === null) {
        wbSteps.splice(idx, 1);
    } else {
        wbSteps[idx].steps.splice(subIdx, 1);
    }
    renderWbSteps();
}

function wbMoveStep(idx, dir, subIdx = null) {
    const arr = subIdx === null ? wbSteps : wbSteps[idx].steps;
    const targetIdx = subIdx === null ? idx : subIdx;
    if (targetIdx + dir < 0 || targetIdx + dir >= arr.length) return;

    const temp = arr[targetIdx];
    arr[targetIdx] = arr[targetIdx + dir];
    arr[targetIdx + dir] = temp;
    renderWbSteps();
}

function wbUpdateStep(idx, subIdx, field, val) {
    const step = subIdx === null ? wbSteps[idx] : wbSteps[idx].steps[subIdx];
    if (field === 'condition_value' || field === 'iterations' || field === 'zone' || field === 'weight') val = Number(val);
    step[field] = val;
    // Special rule for target_type changing to zone
    if (field === 'target_type' && val.endsWith('.zone') && !step.zone) {
        step.zone = 2;
        renderWbSteps();
    }
    // Only re-calculate TSS if condition_type or value changes
    if (field === 'condition_type' || field === 'condition_value' || field === 'iterations') {
        calculateWbTss();
    }
}

function renderWbSteps() {
    const container = document.getElementById('wb-steps-container');
    if (!container) return;

    calculateWbTss();

    if (wbSteps.length === 0) {
        container.innerHTML = `<div class="text-xs text-theme-muted italic py-4 text-center border border-dashed border-theme-border rounded-lg">No structured steps. Click above to add blocks.</div>`;
        return;
    }

    let html = '';
    const isStrength = document.getElementById('edit-workout-sport').value === 'Strength';

    wbSteps.forEach((s, idx) => {
        html += renderWbBlock(s, idx, null, isStrength);
    });
    container.innerHTML = html;
}

function renderWbBlock(s, idx, parentIdx, isStrength) {
    const isSub = parentIdx !== null;
    const isRepeat = s.type === 'repeat';

    // Color coding for blocks
    let bgClass = "bg-theme-bg border-theme-border";
    if (s.type === 'warmup') bgClass = "bg-green-500/10 border-green-500/30";
    if (s.type === 'interval') bgClass = "bg-blue-500/10 border-blue-500/30";
    if (s.type === 'recovery') bgClass = "bg-amber-500/10 border-amber-500/30";
    if (s.type === 'cooldown') bgClass = "bg-purple-500/10 border-purple-500/30";
    if (s.type === 'repeat') bgClass = "bg-theme-accent/5 border-theme-accent/30";

    let html = `<div class="flex flex-col border rounded-md ${bgClass} p-2 relative ${isSub ? 'mt-2' : ''}">`;

    // Top Row
    html += `<div class="flex flex-wrap items-center gap-2">`;

    // Drag/Reorder handles
    html += `<div class="flex flex-col gap-0.5 opacity-50 hover:opacity-100">
        <button onclick="wbMoveStep(${isSub ? parentIdx : idx}, -1, ${isSub ? idx : 'null'})" class="hover:text-theme-accent"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg></button>
        <button onclick="wbMoveStep(${isSub ? parentIdx : idx}, 1, ${isSub ? idx : 'null'})" class="hover:text-theme-accent"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg></button>
    </div>`;

    html += `<div class="text-[10px] uppercase font-bold text-theme-text w-16 truncate">${s.type}</div>`;

    if (isRepeat) {
        html += `<input type="number" onchange="wbUpdateStep(${idx}, null, 'iterations', this.value)" value="${s.iterations || 1}" class="w-12 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] text-right focus:border-theme-accent">`;
        html += `<span class="text-[10px] text-theme-muted">times</span>`;
    } else {
        html += `<input type="number" onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'condition_value', this.value)" value="${s.condition_value || 0}" class="w-12 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] text-right focus:border-theme-accent">`;
        html += `<select onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'condition_type', this.value)" class="bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] focus:border-theme-accent">
            <option value="time" ${s.condition_type === 'time' ? 'selected' : ''}>min</option>
            <option value="time_sec" ${s.condition_type === 'time_sec' ? 'selected' : ''}>sec</option>
            <option value="distance" ${s.condition_type === 'distance' ? 'selected' : ''}>m</option>
            <option value="reps" ${s.condition_type === 'reps' ? 'selected' : ''}>reps</option>
        </select>`;

        if (isStrength) {
            html += `<input type="text" placeholder="Exercise name..." onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'exerciseName', this.value)" value="${s.exerciseName || ''}" class="flex-1 min-w-[80px] bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] focus:border-theme-accent">`;
            html += `<input type="number" placeholder="kg" onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'weight', this.value)" value="${s.weight || ''}" class="w-12 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] text-right focus:border-theme-accent"><span class="text-[10px] text-theme-muted">kg</span>`;
        } else {
            html += `<span class="text-[10px] text-theme-muted px-1">@</span>`;

            html += `<select onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'target_type', this.value); renderWbSteps();" class="bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] focus:border-theme-accent">
                <option value="no.target" ${s.target_type === 'no.target' ? 'selected' : ''}>Open</option>
                <option value="heart.rate.zone" ${s.target_type === 'heart.rate.zone' ? 'selected' : ''}>HR Zone</option>
                <option value="power.zone" ${s.target_type === 'power.zone' ? 'selected' : ''}>Power Zone</option>
                <option value="pace.zone" ${s.target_type === 'pace.zone' ? 'selected' : ''}>Pace Zone</option>
                <option value="pace.exact" ${s.target_type === 'pace.exact' ? 'selected' : ''}>Pace (Exact)</option>
                <option value="speed.zone" ${s.target_type === 'speed.zone' ? 'selected' : ''}>Speed Zone</option>
            </select>`;

            if (s.target_type && s.target_type.endsWith('.zone')) {
                html += `<input type="number" placeholder="Zone (1-5)" onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'zone', this.value)" value="${s.zone || ''}" class="w-16 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] text-right focus:border-theme-accent">`;
            } else if (s.target_type === 'pace.exact') {
                html += `<input type="text" placeholder="e.g. 5:00" onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'target_value', this.value)" value="${s.target_value || ''}" class="w-20 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] focus:border-theme-accent">`;
                html += `<span class="text-[10px] text-theme-muted">/km</span>`;
            } else if (s.target_type !== 'no.target') {
                html += `<input type="text" placeholder="Target..." onchange="wbUpdateStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'}, 'target_value', this.value)" value="${s.target_value || ''}" class="w-20 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-[10px] focus:border-theme-accent">`;
            }
        }
    }

    html += `<div class="ml-auto flex items-center">
        <button onclick="wbRemoveStep(${isSub ? parentIdx : idx}, ${isSub ? idx : 'null'})" class="text-red-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
    </div>`;

    html += `</div>`; // End Top Row

    // Sub-steps for Repeat
    if (isRepeat) {
        html += `<div class="pl-6 ml-2 mt-2 border-l-2 border-theme-accent/30 space-y-2">`;
        (s.steps || []).forEach((subStep, subIdx) => {
            html += renderWbBlock(subStep, subIdx, idx, isStrength);
        });
        html += `<div class="flex gap-2">
            <button onclick="wbSteps[${idx}].steps.push({type:'interval', condition_type: '${isStrength ? 'reps' : 'time'}', condition_value:1, target_type:'no.target', weight: 0, exerciseName: ''}); renderWbSteps();" class="text-[9px] px-2 py-1 bg-theme-bg border border-theme-border rounded hover:bg-theme-border transition">+ Add Substep</button>
        </div>`;
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

if (document.getElementById('btn-edit-workout-save')) {
    document.getElementById('btn-edit-workout-save').addEventListener('click', async () => {
        const date = document.getElementById('edit-workout-date').value;
        const sport = document.getElementById('edit-workout-sport').value;
        const desc = document.getElementById('edit-workout-desc').value;
        const tss = parseFloat(document.getElementById('edit-workout-tss').value) || 0;
        const stepsJson = JSON.stringify(wbSteps);

        if (wbCurrentWorkoutId) {
            // UPDATE
            await fetch(`/api/micro-plan/${wbCurrentWorkoutId}`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({ date: date, sport: sport, description: desc, target_tss: tss, details: '', steps_json: stepsJson })
            });
        } else {
            // CREATE - add a single new workout instead of overwriting the day
            await fetch(`/api/micro-plan`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ date: date, sport: sport, description: desc, target_tss: tss, details: '', steps_json: stepsJson })
            });
        }

        if (navigator.vibrate) navigator.vibrate(50);
        closeEditWorkoutModal();
        loadMicroPlan();
    });
}

if (document.getElementById('btn-edit-workout-delete')) {
    document.getElementById('btn-edit-workout-delete').addEventListener('click', async () => {
        if (!wbCurrentWorkoutId) return;
        await fetch(`/api/micro-plan/${wbCurrentWorkoutId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        closeEditWorkoutModal();
        loadMicroPlan();
    });
}

if (document.getElementById('btn-edit-workout-garmin')) {
    document.getElementById('btn-edit-workout-garmin').addEventListener('click', async () => {
        const sport = document.getElementById('edit-workout-sport').value;
        const date = document.getElementById('edit-workout-date').value;
        if (wbCurrentWorkoutId) {
            syncSingleToGarmin(wbCurrentWorkoutId, date, sport);
        }
    });
}

async function syncSingleToGarmin(id, dateStr, sport) {
    if (sport === 'Rest') return;
    showToast(`Syncing ${sport} to Garmin...`);

    try {
        const res = await fetch('/api/sync-garmin', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ workouts: [{ date: dateStr, sport: sport }] })
        });
        const result = await res.json();

        if (result.success) {
            showToast(`✅ Synced successfully!`, 'success');
        } else {
            showToast(`❌ Sync failed: ${result.error || result.message}`, 'error');
        }
    } catch (e) {
        showToast(`❌ Connection error`, 'error');
    }
}

async function generateTemplate() {
    // 1. Scrape the current metrics from the DOM
    const ctlText = document.getElementById('ctl-metric').innerText;
    const atlText = document.getElementById('atl-metric').innerText;

    // 2. Parse them into numbers
    const currentFitness = parseFloat(ctlText) || 0;
    const currentFatigue = parseFloat(atlText) || 0;
    const targetDate = viewingWeekStart.toISOString().split('T')[0];

    // 3. Prepare the payload object
    const payload = {
        targetDate: targetDate,
        fitness: currentFitness,
        fatigue: currentFatigue
    };

    // 4. Log the message/payload to the console
    console.log("🚀 Generating Spark plan for:", targetDate);
    console.log("📊 Sending metrics payload:", payload);

    // 5. Send to the backend
    try {
        const response = await fetch('/api/generate-plan', {
            method: 'POST',
            headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json' // Ensure this is set
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error("Backend error response:", await response.text());
        } else {
            console.log("✅ Spark plan generated successfully!");
        }
    } catch (error) {
        console.error("❌ Fetch error:", error);
    }

    // 6. Reload the plan
    loadMicroPlan();
}

// --- MAP & HISTORY MODAL ---
function decodePolyline(str) {
    let index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = 1e5;
    while (index < str.length) {
        byte = null; shift = 0; result = 0;
        do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1)); shift = result = 0;
        do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += latitude_change; lng += longitude_change; coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
}

async function openActivityModal(id) {
    const modal = document.getElementById('activity-modal');
    const content = document.getElementById('activity-modal-content');
    modal.classList.remove('hidden');
    // Force reflow
    void modal.offsetWidth;
    modal.classList.remove('opacity-0');
    content.classList.remove('translate-y-full', 'md:scale-95');
    content.classList.add('translate-y-0', 'md:scale-100');

    document.getElementById('modal-loader').classList.remove('hidden');
    document.getElementById('modal-content').classList.add('hidden');
    document.getElementById('modal-title').innerText = "Connecting to Strava...";
    try {
        const res = await fetch(`/api/activity/${id}`, { headers: getAuthHeaders() }); const data = await res.json();
        document.getElementById('modal-title').innerText = data.name || "Activity Details";
        let hrStr = data.has_heartrate ? `${Math.round(data.average_heartrate)} bpm` : '--'; let elevStr = data.total_elevation_gain ? `${Math.round(data.total_elevation_gain)} m` : '--'; let sufferStr = data.suffer_score || '--';
        let distStr = '--';
        if (data.distance) {
            distStr = data.type === 'Swim' ? `${Math.round(data.distance)} m` : `${(data.distance / 1000).toFixed(2)} km`;
        }
        let cadenceStr = '--';
        if (data.average_cadence) {
            if (data.type === 'Run') {
                // Multiply by 2 for running to get steps per minute
                cadenceStr = `${Math.round(data.average_cadence * 2)} spm`;
            } else {
                // Use raw value for cycling (RPM)
                cadenceStr = `${Math.round(data.average_cadence)} rpm`;
            }
        }

        let paceSpeedLabel = 'Avg Pace';
        let paceSpeedStr = '--';
        if (data.distance && data.moving_time) {
            if (data.type === 'Ride' || data.type === 'EBikeRide' || data.type === 'VirtualRide') {
                paceSpeedLabel = 'Avg Speed';
                let speedKmh = ((data.distance / 1000) / (data.moving_time / 3600)).toFixed(1);
                paceSpeedStr = `${speedKmh} km/h`;
            } else if (data.type === 'Swim') {
                paceSpeedLabel = 'Avg Pace';
                let swimPaceDecimal = (data.moving_time / 60) / (data.distance / 100);
                let swimMins = Math.floor(swimPaceDecimal);
                let swimSecs = Math.round((swimPaceDecimal - swimMins) * 60).toString().padStart(2, '0');
                if (swimSecs === '60') { swimMins += 1; swimSecs = '00'; }
                paceSpeedStr = `${swimMins}:${swimSecs} /100m`;
            } else { // Run, Walk, Hike
                paceSpeedLabel = 'Avg Pace';
                let paceDecimal = (data.moving_time / 60) / (data.distance / 1000);
                let paceMins = Math.floor(paceDecimal);
                let paceSecs = Math.round((paceDecimal - paceMins) * 60).toString().padStart(2, '0');
                if (paceSecs === '60') { paceMins += 1; paceSecs = '00'; }
                paceSpeedStr = `${paceMins}:${paceSecs} /km`;
            }
        }

        let movingTimeStr = '--';
        if (data.moving_time) {
            let h = Math.floor(data.moving_time / 3600);
            let m = Math.floor((data.moving_time % 3600) / 60);
            let s = Math.floor(data.moving_time % 60);
            movingTimeStr = h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
        }
        let pwrStr = data.average_watts ? `${Math.round(data.average_watts)} W` : '--';

        document.getElementById('modal-stats').innerHTML = `
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Distance</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${distStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Moving Time</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${movingTimeStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">${paceSpeedLabel}</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${paceSpeedStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Elevation</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${elevStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Avg HR</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${hrStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Avg Power</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${pwrStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Cadence</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${cadenceStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Suffer Score</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${sufferStr}</div>
                </div>`;

        if (data.laps && data.laps.length > 0) {
            document.getElementById('modal-laps-container').classList.remove('hidden');
            document.getElementById('modal-laps-table').innerHTML = data.laps.map(lap => {
                let dist = '--';
                if (lap.distance) {
                    dist = data.type === 'Swim' ? `${Math.round(lap.distance)} m` : `${(lap.distance / 1000).toFixed(2)} km`;
                }

                let time = '--';
                if (lap.moving_time) {
                    let mins = Math.floor(lap.moving_time / 60);
                    let secs = Math.round(lap.moving_time % 60).toString().padStart(2, '0');
                    if (secs === '60') { mins += 1; secs = '00'; }
                    time = `${mins}:${secs}`;
                }

                let paceSpd = '--';
                if (lap.distance && lap.moving_time) {
                    if (data.type === 'Ride' || data.type === 'EBikeRide' || data.type === 'VirtualRide') {
                        let speedKmh = ((lap.distance / 1000) / (lap.moving_time / 3600)).toFixed(1);
                        paceSpd = `${speedKmh}`;
                    } else if (data.type === 'Swim') {
                        let swimPaceDecimal = (lap.moving_time / 60) / (lap.distance / 100);
                        let sMins = Math.floor(swimPaceDecimal);
                        let sSecs = Math.round((swimPaceDecimal - sMins) * 60).toString().padStart(2, '0');
                        if (sSecs === '60') { sMins += 1; sSecs = '00'; }
                        paceSpd = `${sMins}:${sSecs}`;
                    } else {
                        let paceDecimal = (lap.moving_time / 60) / (lap.distance / 1000);
                        let pMins = Math.floor(paceDecimal);
                        let pSecs = Math.round((paceDecimal - pMins) * 60).toString().padStart(2, '0');
                        if (pSecs === '60') { pMins += 1; pSecs = '00'; }
                        paceSpd = `${pMins}:${pSecs}`;
                    }
                }

                let hr = lap.average_heartrate ? `${Math.round(lap.average_heartrate)}` : '--';
                let pwr = lap.average_watts ? `${Math.round(lap.average_watts)}` : '--';
                let lapName = lap.name ? `<span class="text-theme-muted font-normal block text-[9px] truncate max-w-[120px]">${lap.name}</span>` : '';

                return `
                    <tr class="hover:bg-theme-bg transition">
                        <td class="px-3 py-2 font-medium">${lap.lap_index || ''} ${lapName}</td>
                        <td class="px-3 py-2">${dist}</td>
                        <td class="px-3 py-2">${time}</td>
                        <td class="px-3 py-2 font-mono">${paceSpd}</td>
                        <td class="px-3 py-2">${hr}</td>
                        <td class="px-3 py-2">${pwr}</td>
                    </tr>
                `;
            }).join('');
        } else {
            document.getElementById('modal-laps-container').classList.add('hidden');
        }
        if (activityMap) activityMap.remove(); document.getElementById('actual-map').innerHTML = '';
        activityMap = L.map('actual-map', { zoomControl: false }); L.control.zoom({ position: 'bottomright' }).addTo(activityMap); L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' }).addTo(activityMap);

        let boundsToFit = null;
        if (data.map && data.map.summary_polyline) {
            const coords = decodePolyline(data.map.summary_polyline);
            if (coords.length > 0) {
                const polyline = L.polyline(coords, { color: '#0f766e', weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(activityMap);
                boundsToFit = polyline.getBounds();
            }
        }

        document.getElementById('modal-loader').classList.add('hidden'); document.getElementById('modal-content').classList.remove('hidden'); document.getElementById('modal-content').classList.add('flex');
        setTimeout(() => {
            activityMap.invalidateSize();
            if (boundsToFit) {
                let dynamicMaxZoom = 15;
                if (data.distance) {
                    if (data.distance < 10000) dynamicMaxZoom = 14;      // < 10km: zoom out more to show neighborhood context
                    else if (data.distance < 30000) dynamicMaxZoom = 13; // < 30km: show city context
                    else dynamicMaxZoom = 12;                            // > 30km: zoom out
                }
                activityMap.fitBounds(boundsToFit, { padding: [40, 40], maxZoom: dynamicMaxZoom });
            } else {
                activityMap.setView([52.3676, 4.9041], 13);
            }
        }, 100);
    } catch (e) { document.getElementById('modal-title').innerText = "Error Fetching Data"; document.getElementById('modal-loader').innerHTML = `<span class="text-red-500 font-bold uppercase tracking-widest text-xs">Connection Failed</span>`; }
}

function closeModal() {
    const modal = document.getElementById('activity-modal');
    const content = document.getElementById('activity-modal-content');

    modal.classList.add('opacity-0');
    content.classList.remove('translate-y-0', 'md:scale-100');
    content.classList.add('translate-y-full', 'md:scale-95');

    // Wait for transition to finish
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300);
}

async function loadHistory() {
    try {
        const res = await fetch('/api/history', { headers: getAuthHeaders() });
        if (!res.ok) return;
        globalHistoryData = await res.json();

        const container = document.getElementById('history-list-container');
        if (!container) return;

        container.innerHTML = globalHistoryData.map((x, idx) => {
            let sportBadge = '';
            let s = x.sport_type ? x.sport_type.toLowerCase() : '';
            if (s.includes('run')) sportBadge = `<span class="bg-orange-100 text-orange-700 border border-orange-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Run</span>`;
            else if (s.includes('swim')) sportBadge = `<span class="bg-blue-100 text-blue-700 border border-blue-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Swim</span>`;
            else if (s.includes('strength')) sportBadge = `<span class="bg-purple-100 text-purple-700 border border-purple-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Strength</span>`;
            else if (s.includes('ride') || s.includes('bike')) sportBadge = `<span class="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Bike</span>`;
            else sportBadge = `<span class="bg-gray-100 text-gray-700 border border-gray-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">${x.sport_type || 'Activity'}</span>`;

            let dateObj = new Date(x.start_date);
            let dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

            return `
                    <div class="flex items-center p-4 hover:bg-theme-bg transition group cursor-pointer" onclick="openActivityModal('${x.id}')">
                        <div class="mr-4 shrink-0" onclick="event.stopPropagation()">
                            <input type="checkbox" class="log-checkbox w-4 h-4 text-theme-accent bg-theme-card border-theme-border rounded cursor-pointer accent-theme-accent" value="${idx}">
                        </div>
                        <div class="flex-1 min-w-0 flex flex-col justify-center">
                            <div class="flex justify-between items-baseline mb-1">
                                <h3 class="text-sm md:text-base font-bold text-theme-text truncate pr-4 group-hover:text-theme-accent transition">${x.name || 'Untitled Activity'}</h3>
                                <span class="text-[10px] md:text-xs text-theme-muted whitespace-nowrap font-medium">${dateStr}</span>
                            </div>
                            <div class="flex items-center gap-3">
                                ${sportBadge}
                                <div class="text-[10px] md:text-xs text-theme-muted flex items-center gap-1 font-mono">
                                    <span class="uppercase tracking-wider font-semibold">TSS:</span>
                                    <span class="text-theme-text">${x.tss || '--'}</span>
                                </div>
                            </div>
                        </div>
                        <div class="ml-3 shrink-0 text-theme-border group-hover:text-theme-accent transition">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                        </div>
                    </div>`
        }).join('');
    } catch (e) { console.error("History Load Error:", e); }
}

function toggleAllLog(source) {
    const checkboxes = document.querySelectorAll('.log-checkbox');
    checkboxes.forEach(cb => cb.checked = source.checked);
}

async function downloadSelectedCSV() {
    const checkboxes = document.querySelectorAll('.log-checkbox:checked');
    if (checkboxes.length === 0) return alert("Please select at least one activity to export.");

    const exportBtn = document.querySelector('button[onclick="downloadSelectedCSV()"]');
    const originalText = exportBtn.innerText;
    exportBtn.innerText = "Exporting...";
    exportBtn.disabled = true;

    let csvContent = "Date,Sport,Title,TSS,Distance (meters),Moving Time (seconds),Elevation (meters),Avg Heart Rate (bpm),Avg Cadence (spm/rpm)\n";

    for (const cb of checkboxes) {
        let item = globalHistoryData[cb.value];
        let cleanTitle = item.name ? item.name.replace(/,/g, '') : "Activity";
        let dist = 0, time = 0, elev = 0, hr = 0, cadence = 0;

        try {
            const res = await fetch(`/api/activity/${item.id}`, { headers: getAuthHeaders() });
            const deepData = await res.json();

            dist = deepData.distance || 0;
            time = deepData.moving_time || 0;
            elev = deepData.total_elevation_gain || 0;
            hr = deepData.has_heartrate ? Math.round(deepData.average_heartrate) : 0;

            let rawCadence = deepData.average_cadence || 0;
            if (item.sport_type === 'Run' && rawCadence > 0) rawCadence = rawCadence * 2;
            cadence = Math.round(rawCadence);
        } catch (e) { }

        let row = [item.start_date.split('T')[0], item.sport_type, cleanTitle, item.tss || 0, dist, time, elev, hr, cadence];
        csvContent += row.join(",") + "\n";
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `ironman_log_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    exportBtn.innerText = originalText;
    exportBtn.disabled = false;
}

// --- AI COACH CHAT LOGIC ---
function togglePassword(id) {
    const el = document.getElementById(id);
    if (el.type === "password") { el.type = "text"; } else { el.type = "password"; }
}

function getCoachAvatar(mood) {
    // Determine the active persona category
    let persona = 'empathetic';
    const toneCheck = currentCoachTone.toLowerCase();
    if (toneCheck.includes('madison')) persona = 'madison';
    else if (toneCheck.includes('strict')) persona = 'strict';
    else if (toneCheck.includes('cheerleader')) persona = 'cheer';

    // IMPORTANT: Create a folder in your 'public' directory called 'avatars'.
    // Save your 12 images there using this naming convention:
    // e.g., 'empathetic-default.png', 'madison-hype.png', 'strict-disappointed.png'

    const validMoods = ['default', 'hype', 'disappointed', 'horny'];
    const moodKey = validMoods.includes(mood) ? mood : 'default';
    const imagePath = `/avatars/${persona}-${moodKey}.png`;

    // Optional Fallback logic if the real images are missing
    const fallbackColors = {
        'empathetic': { default: '14b8a6', hype: '10b981', disappointed: 'f43f5e', horny: '10b981' },
        'strict': { default: '3b82f6', hype: '2563eb', disappointed: 'dc2626', horny: '2563eb' },
        'cheer': { default: 'ec4899', hype: 'd946ef', disappointed: 'f43f5e', horny: 'd946ef' },
        'madison': { default: '374151', hype: '111827', disappointed: '7f1d1d', horny: '111827' }
    };
    const c = fallbackColors[persona][moodKey] || fallbackColors[persona].default;
    const fallbackUrl = `https://ui-avatars.com/api/?name=Coach&background=${c}&color=fff&size=128`;

    // Try to load the local image; if you haven't uploaded it yet, it will fail silently in the browser 
    // and you can use an onerror attribute in the HTML, but for now we'll just return the path.
    // When you create the images, uncomment the imagePath return!

    return imagePath;
    return fallbackUrl;
}

async function loadChatHistory() {
    try {
        const res = await fetch('/api/chat/history', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const history = await res.json();
        const chatWindow = document.getElementById('chat-window');
        if (!chatWindow) return;

        let lastCoachMsg = null;
        let lastCoachAvatar = getCoachAvatar('default');

        if (!history || history.length === 0) {
            let timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            chatWindow.innerHTML = `
                        <div class="flex items-end gap-2 md:gap-3">
                            <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                                <img onclick="enlargeAvatar(this.src)" src="${lastCoachAvatar}" alt="Coach" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                            </div>
                            <div class="bg-theme-card border border-theme-border text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-bl-none max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text relative">
                                <span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>
                                <div class="whitespace-pre-wrap leading-relaxed">Systems nominal. I have synchronized your latest profile settings. Ready to get to work?</div>
                                <div class="text-[9px] text-theme-muted text-right mt-1">${timeStr}</div>
                            </div>
                        </div>`;
            lastCoachMsg = "Systems nominal. I have synchronized your latest profile settings. Ready to get to work?";
        } else {
            let html = '';
            history.forEach(msg => {
                let timeStr = '';
                if (msg.timestamp) {
                    let dateObj = new Date(msg.timestamp + 'Z');
                    timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }

                if (msg.role === 'user') {
                    let imgHtml = msg.image_path ? `<img src="${msg.image_path}" onerror="this.outerHTML='<div class=\\'text-[10px] italic opacity-50 mb-2\\'>Image expired</div>'" class="w-full rounded-xl mb-1 object-cover">` : '';
                    html += `
                                <div class="flex justify-end">
                                    <div class="bg-theme-accent text-white text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-br-none max-w-[85%] md:max-w-[75%] shadow-sm relative">
                                        ${imgHtml}
                                        <div class="whitespace-pre-wrap leading-relaxed">${msg.content}</div>
                                        ${timeStr ? `<div class="text-[9px] text-white/70 text-right mt-1">${timeStr}</div>` : ''}
                                    </div>
                                </div>`;
                } else {
                    let avatarImg = getCoachAvatar(msg.mood || 'default');
                    lastCoachAvatar = avatarImg;
                    let formattedContent = msg.content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    formattedContent = formattedContent.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<img src="$2" alt="$1" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full md:w-3/4 rounded-xl my-1 shadow-sm object-cover">');
                    lastCoachMsg = formattedContent;
                    html += `
                                <div class="flex items-end gap-2 md:gap-3">
                                    <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                                        <img src="${avatarImg}" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                                    </div>
                                    <div class="bg-theme-card border border-theme-border text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-bl-none max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text relative">
                                        ${msg.mood !== 'default' ? `<span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>` : ''}
                                        <div class="whitespace-pre-wrap leading-relaxed">${formattedContent}</div>
                                        ${timeStr ? `<div class="text-[9px] text-theme-muted text-right mt-1">${timeStr}</div>` : ''}
                                    </div>
                                </div>`;
                }
            });
            chatWindow.innerHTML = html;
        }

        chatWindow.scrollTop = chatWindow.scrollHeight;

        // Proactive Check-in Logic & Unread Badge
        if (history && history.length > 0) {
            const lastMsg = history[history.length - 1];
            // SQLite DATETIME 'CURRENT_TIMESTAMP' is in UTC
            const lastTime = new Date(lastMsg.timestamp + 'Z').getTime();
            const now = Date.now();

            // Check for unread messages from coach
            const lastCoachMsg = [...history].reverse().find(m => m.role === 'coach');
            if (lastCoachMsg) {
                updateUnreadBadge(new Date(lastCoachMsg.timestamp + 'Z').getTime());
            }

            // Check if older than 24 hours (24 * 60 * 60 * 1000)
            if (now - lastTime > 86400000) {
                triggerProactiveCheckin();
            }
        }
    } catch (e) { console.error("Chat History Load Error:", e); }
}

async function triggerProactiveCheckin() {
    const chatWindow = document.getElementById('chat-window');
    if (!chatWindow) return;

    const loadId = 'typing-' + Date.now();
    chatWindow.insertAdjacentHTML('beforeend', `
        <div id="${loadId}" class="flex items-end gap-2 md:gap-3 text-theme-text/50 animate-msg">
            <span class="text-xs italic">Spark is typing...</span>
        </div>
    `);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    try {
        const res = await fetch('/api/chat/checkin', {
            method: 'POST',
            headers: getAuthHeaders()
        });

        if (!res.ok) {
            document.getElementById(loadId).remove();
            return;
        }

        const data = await res.json();
        let finalAvatar = getCoachAvatar(data.mood || 'default');
        let formattedContent = data.reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        formattedContent = formattedContent.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<img src="$2" alt="$1" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full md:w-3/4 rounded-lg my-2 border border-theme-border shadow-sm">');

        const msgId = 'reply-content-' + Date.now();
        document.getElementById(loadId).outerHTML = `
            <div class="flex items-end gap-2 md:gap-3">
                <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card transition-all">
                    <img src="${finalAvatar}" alt="Coach" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                </div>
                <div class="bg-theme-card border border-theme-border text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-bl-sm max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text animate-fade-in">
                    <span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>
                    <span id="${msgId}" class="whitespace-pre-wrap"></span>
                </div>
            </div>
        `;

        chatWindow.scrollTop = chatWindow.scrollHeight;

        // Update Dashboard Coach's Desk
        const deskAvatar = document.getElementById('desk-coach-avatar');
        if (deskAvatar) deskAvatar.src = finalAvatar;
        const deskReflection = document.getElementById('daily-reflection');
        if (deskReflection) deskReflection.innerHTML = formattedContent;

        // Add a red dot to the chat tab if they aren't on it
        if (typeof currentTab !== 'undefined' && currentTab !== 'coach') {
            const chatBadge = document.getElementById('chat-badge');
            if (chatBadge) chatBadge.classList.remove('hidden');
        }

        speakResponse(data.reply, data.mood || 'default', localStorage.getItem('coachTone'));

        updateUnreadBadge(Date.now());

        // Typewriter effect (token streaming simulation)
        const targetEl = document.getElementById(msgId);
        let i = 0;
        function typeStep() {
            if (i < formattedContent.length) {
                if (formattedContent.charAt(i) === '<') {
                    let tag = '';
                    while (formattedContent.charAt(i) !== '>' && i < formattedContent.length) {
                        tag += formattedContent.charAt(i);
                        i++;
                    }
                    tag += '>';
                    targetEl.innerHTML += tag;
                    i++;
                } else {
                    let chunkLength = Math.floor(Math.random() * 5) + 3; // 3 to 7 characters
                    let chunk = '';
                    while (chunkLength > 0 && i < formattedContent.length && formattedContent.charAt(i) !== '<') {
                        chunk += formattedContent.charAt(i);
                        i++;
                        chunkLength--;
                    }
                    targetEl.innerHTML += chunk;
                }
                chatWindow.scrollTop = chatWindow.scrollHeight;
                setTimeout(typeStep, 25); // Delay between token chunks
            }
        }
        typeStep();

    } catch (error) {
        const typingEl = document.getElementById(loadId);
        if (typingEl) typingEl.remove();
    }
}

// --- AVATAR MODAL LOGIC ---
function enlargeAvatar(src) {
    const modal = document.getElementById('image-modal');
    const img = document.getElementById('enlarged-img');
    if (modal && img) {
        img.src = src;
        modal.classList.remove('hidden');
    }
}

let currentImageBase64 = null;

function handleImageSelection(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 1024;
            const MAX_HEIGHT = 1024;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > MAX_WIDTH) {
                    height *= MAX_WIDTH / width;
                    width = MAX_WIDTH;
                }
            } else {
                if (height > MAX_HEIGHT) {
                    width *= MAX_HEIGHT / height;
                    height = MAX_HEIGHT;
                }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            currentImageBase64 = canvas.toDataURL('image/jpeg', 0.8);

            document.getElementById('image-preview').src = currentImageBase64;
            document.getElementById('image-preview-container').classList.remove('hidden');
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
}

function clearImageSelection() {
    currentImageBase64 = null;
    document.getElementById('image-upload').value = '';
    document.getElementById('image-preview-container').classList.add('hidden');
    document.getElementById('image-preview').src = '';
}

function renderQuickActions(planMap, tssMap) {
    const container = document.getElementById('quick-actions-container');
    if (!container) return;

    let todayStr = new Date().toISOString().split('T')[0];
    let actualTss = tssMap[todayStr] || 0;

    // Check if there is a scheduled workout today that isn't just rest
    let workoutsToday = planMap[todayStr] || [];
    let isRestDay = workoutsToday.length === 0 || (workoutsToday.length === 1 && workoutsToday[0].sport.toLowerCase() === 'rest');

    let actions = [];

    if (actualTss > 0) {
        // Workout completed today
        actions.push({ text: "🔥 Debrief Workout", msg: "I crushed my workout today! Let's debrief." });
        actions.push({ text: "📉 Felt Terrible", msg: "That workout felt terrible today, I really struggled." });
    } else if (!isRestDay) {
        // Workout scheduled but not completed yet
        actions.push({ text: "🏃‍♂️ Warmup Routine", msg: "Give me a quick warmup routine for my workout today." });
        actions.push({ text: "🥱 Too Tired", msg: "I am feeling extremely tired today, can we modify or skip the plan?" });
        actions.push({ text: "🍽️ Nutrition Focus", msg: "What should I eat before this workout?" });
    } else {
        // Rest day, no workout completed
        actions.push({ text: "🧘‍♂️ Stretching Routine", msg: "Recommend a light stretching or yoga routine for my rest day." });
        actions.push({ text: "🥗 Nutrition Focus", msg: "Give me a nutrition focus for my rest day today." });
    }

    let html = `<span class="text-[10px] uppercase font-bold text-theme-muted tracking-wider self-center mr-2">Quick Actions:</span>`;
    actions.forEach(act => {
        // Escape quotes safely
        let safeMsg = act.msg.replace(/'/g, "\\'");
        html += `<button onclick="sendQuickAction('${safeMsg}')" class="text-xs text-theme-accent bg-theme-accent-soft border border-theme-accent-border px-3 py-1.5 rounded-full hover:bg-theme-accent transition font-medium hover:text-white">${act.text}</button>`;
    });

    container.innerHTML = html;
}

async function sendQuickAction(msg) {
    switchTab('coach');
    document.getElementById('chat-input').value = msg;
    sendMessage();
}

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message && !currentImageBase64) return;

    if (navigator.vibrate) navigator.vibrate(50);

    const chatWindow = document.getElementById('chat-window');

    let timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let userImgHtml = '';
    if (currentImageBase64) {
        userImgHtml = `<img src="${currentImageBase64}" class="w-full rounded-xl mb-1 object-cover animate-pop">`;
    }

    chatWindow.insertAdjacentHTML('beforeend', `
                <div class="flex justify-end animate-msg">
                    <div class="bg-theme-accent text-white text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-br-none max-w-[85%] md:max-w-[75%] shadow-sm relative">
                        ${userImgHtml}
                        <div class="whitespace-pre-wrap leading-relaxed">${message}</div>
                        <div class="text-[9px] text-white/70 text-right mt-1">${timeStr}</div>
                    </div>
                </div>`);

    const payload = { message, imageBase64: currentImageBase64 };

    input.value = '';
    input.style.height = '44px';
    clearImageSelection();
    chatWindow.scrollTop = chatWindow.scrollHeight;

    const loadId = 'loading-' + Date.now();
    let thinkingAvatar = getCoachAvatar('thinking');

    chatWindow.insertAdjacentHTML('beforeend', `
                <div class="flex items-end gap-2 md:gap-3 animate-msg" id="${loadId}">
                    <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                        <img src="${thinkingAvatar}" alt="Coach" class="w-full h-full object-cover opacity-70">
                    </div>
                    <div class="bg-theme-card border border-theme-border text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-bl-none shadow-sm text-theme-text flex items-center gap-1.5 h-[44px]">
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce"></span>
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce" style="animation-delay: 0.15s"></span>
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce" style="animation-delay: 0.3s"></span>
                    </div>
                </div>`);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.status === 429) {
            document.getElementById(loadId).outerHTML = `
                <div class="flex items-end gap-2 md:gap-3 animate-msg">
                    <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card transition-all">
                        <img src="${getCoachAvatar('disappointed')}" alt="Coach" class="w-full h-full object-cover">
                    </div>
                    <div class="bg-theme-card border border-theme-border text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-bl-none max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text relative">
                        <div class="whitespace-pre-wrap leading-relaxed text-theme-accent font-bold">${data.error || "Daily token limit reached. Please try again tomorrow!"}</div>
                    </div>
                </div>`;
            chatWindow.scrollTop = chatWindow.scrollHeight;
            return;
        }

        let finalAvatar = getCoachAvatar(data.mood || 'default');
        let formattedContent = data.reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        formattedContent = formattedContent.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<img src="$2" alt="$1" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full md:w-3/4 rounded-xl my-1 shadow-sm object-cover animate-pop">');

        let replyTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const msgId = 'reply-content-' + Date.now();
        document.getElementById(loadId).outerHTML = `
                    <div class="flex items-end gap-2 md:gap-3 animate-msg">
                        <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card transition-all">
                            <img src="${finalAvatar}" alt="Coach" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                        </div>
                        <div class="bg-theme-card border border-theme-border text-xs md:text-sm px-3 py-2 md:px-4 md:py-3 rounded-2xl rounded-bl-none max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text relative">
                            ${data.mood !== 'default' ? `<span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>` : ''}
                            <div id="${msgId}" class="whitespace-pre-wrap leading-relaxed"></div>
                            <div class="text-[9px] text-theme-muted text-right mt-1">${replyTimeStr}</div>
                        </div>
                    </div>`;

        chatWindow.scrollTop = chatWindow.scrollHeight;
        if (data.planUpdated) {
            loadMicroPlan();
            buildDashboard(); // Refresh graphs if a manual activity was logged
        }

        speakResponse(data.reply, data.mood || 'default', localStorage.getItem('coachTone'));

        // Typewriter effect (token streaming simulation)
        const targetEl = document.getElementById(msgId);
        let i = 0;
        let currentHTML = '';
        function typeStep() {
            if (!document.getElementById(msgId)) return; // Stop if user switched tabs and chat reloaded

            if (i < formattedContent.length) {
                if (formattedContent.charAt(i) === '<') {
                    let tag = '';
                    while (formattedContent.charAt(i) !== '>' && i < formattedContent.length) {
                        tag += formattedContent.charAt(i);
                        i++;
                    }
                    tag += '>';
                    currentHTML += tag;
                    i++;
                } else {
                    let chunkLength = Math.floor(Math.random() * 5) + 3; // 3 to 7 characters
                    let chunk = '';
                    while (chunkLength > 0 && i < formattedContent.length && formattedContent.charAt(i) !== '<') {
                        chunk += formattedContent.charAt(i);
                        i++;
                        chunkLength--;
                    }
                    currentHTML += chunk;
                }
                targetEl.innerHTML = currentHTML;
                chatWindow.scrollTop = chatWindow.scrollHeight;
                setTimeout(typeStep, 25); // Delay between token chunks
            }
        }
        typeStep();

    } catch (error) {
        console.error("Chat Error:", error);
        const loadEl = document.getElementById(loadId);
        if (loadEl) {
            loadEl.outerHTML = `
                <div class="flex justify-center my-4">
                    <div class="bg-red-50 text-red-500 text-xs px-4 py-2 rounded-full border border-red-100 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        Connection interrupted. Please try again.
                    </div>
                </div>
            `;
        }
    }
}

// --- MANUAL WEIGHT LOGGING (UPDATED FOR COMMAS) ---
async function submitManualWeight() {
    // Replace commas with periods to make JavaScript happy
    const weightInput = document.getElementById('log-weight').value.replace(',', '.');
    const bfInput = document.getElementById('log-bf').value.replace(',', '.');

    if (!weightInput || isNaN(parseFloat(weightInput))) {
        alert("Please enter a valid weight in kg.");
        return;
    }

    const dateStr = new Date().toLocaleDateString('en-CA');

    const payload = {
        date: dateStr,
        weight_kg: parseFloat(weightInput),
        body_fat_percent: bfInput ? parseFloat(bfInput) : null
    };

    try {
        const res = await fetch('/api/weight', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            if (navigator.vibrate) navigator.vibrate(50);
            document.getElementById('log-weight').value = '';
            document.getElementById('log-bf').value = '';
            buildDashboard();
        } else {
            alert("Failed to save weight. Check server console.");
        }
    } catch (e) {
        console.error(e);
    }
}

function toggleGarminBtn() {
    const checkboxes = document.querySelectorAll('.garmin-sync-cb:checked');
    const btn = document.getElementById('garmin-sync-btn');
    if (btn) {
        if (checkboxes.length === 0) {
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
            btn.classList.remove('hover:bg-theme-border');
        } else {
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
            btn.classList.add('hover:bg-theme-border');
        }
    }
}

// --- ADMIN USAGE LOGIC ---
async function loadAdminUsage() {
    try {
        const usageRes = await fetch('/api/admin/usage', { headers: getAuthHeaders() });
        if (usageRes.ok) {
            const usageData = await usageRes.json();
            const usageTbody = document.getElementById('admin-usage-table');
            if (usageTbody) {
                if (usageData.length === 0) {
                    usageTbody.innerHTML = `<tr><td colspan="6" class="px-4 py-8 text-center text-theme-muted">No usage data.</td></tr>`;
                } else {
                    usageTbody.innerHTML = usageData.map(u => {
                        const tokenUsage = u.daily_token_usage || 0;
                        const tokenPercent = Math.min(100, Math.round((tokenUsage / 50000) * 100));
                        let tokenColor = 'bg-green-500';
                        if (tokenPercent > 75) tokenColor = 'bg-yellow-500';
                        if (tokenPercent > 90) tokenColor = 'bg-red-500';

                        return `
                        <tr class="hover:bg-theme-bg transition border-b border-theme-border last:border-0">
                            <td class="px-4 py-3 font-medium text-xs">${u.username || 'Unknown'}</td>
                            <td class="px-4 py-3 text-xs text-theme-muted">${u.login_count || 0}</td>
                            <td class="px-4 py-3 text-xs text-theme-muted">${u.chat_count || 0}</td>
                            <td class="px-4 py-3 text-xs text-theme-muted">
                                <div class="flex items-center gap-2">
                                    <div class="w-full h-1.5 bg-theme-border rounded-full overflow-hidden shrink-0">
                                        <div class="h-full ${tokenColor} rounded-full" style="width: ${tokenPercent}%"></div>
                                    </div>
                                    <span class="text-[10px] w-8 text-right">${tokenPercent}%</span>
                                </div>
                            </td>
                            <td class="px-4 py-3 text-xs text-theme-muted">${u.strava_connected ? '✅' : '❌'}</td>
                            <td class="px-4 py-3 text-xs text-theme-muted">${u.garmin_connected ? '✅' : '❌'}</td>
                            <td class="px-4 py-3 text-xs text-theme-muted">${u.activities_count || 0}</td>
                        </tr>
                        `;
                    }).join('');
                }
            }
        }
    } catch (e) {
        console.error("Failed to load admin usage", e);
    }
}
// --- ONBOARDING LOGIC ---
function selectTone(element, tone) {
    document.getElementById('onboard-tone').value = tone;

    // Reset all cards visually
    const cards = document.querySelectorAll('.tone-card');
    cards.forEach(card => {
        card.classList.remove('border-theme-accent', 'bg-theme-accent-soft');
        card.classList.add('border-theme-border', 'bg-theme-bg');
    });

    // Highlight selected card
    element.classList.remove('border-theme-border', 'bg-theme-bg');
    element.classList.add('border-theme-accent', 'bg-theme-accent-soft');
}

async function completeOnboarding(redirectUrl = null) {
    const btn = document.getElementById('btn-complete-setup');
    if (btn) btn.innerText = "Saving profile...";

    let context = document.getElementById('onboard-context').value;

    const metricRows = document.querySelectorAll('.onboard-metric-row');
    let extraContext = [];
    if (metricRows.length > 0) {
        Array.from(metricRows).forEach(row => {
            const mKey = row.querySelector('.onboard-metric-key').value.trim();
            const mVal = row.querySelector('.onboard-metric-val').value.trim();
            if (mKey && mVal) {
                extraContext.push(`${mKey}: ${mVal}`);
            }
        });
    }

    if (extraContext.length > 0) {
        context = (context ? context + '\n\n' : '') + 'Personal Metrics:\n' + extraContext.join('\n');
    }

    const tone = document.getElementById('onboard-tone').value;
    const garminUser = document.getElementById('onboard-garmin-user').value;
    const garminPass = document.getElementById('onboard-garmin-pass').value;
    const raceDate = document.getElementById('onboard-race-date').value;
    const raceName = document.getElementById('onboard-race-name').value;
    const raceCtl = document.getElementById('onboard-race-ctl').value;

    try {
        // 1. Save Coach Settings
        await fetch('/api/user/settings/coach', {
            method: 'POST', headers: getAuthHeaders(),
            body: JSON.stringify({ coachTone: tone, athleteContext: context || 'Endurance Athlete' })
        });

        // 2. Save Garmin (if provided)
        if (garminUser && garminPass) {
            await fetch('/api/user/settings/garmin', {
                method: 'POST', headers: getAuthHeaders(),
                body: JSON.stringify({ garminUsername: garminUser, garminPassword: garminPass })
            });
        }

        // 3. Save Milestone (if provided)
        if (raceDate && raceName) {
            await fetch('/api/milestones', {
                method: 'POST', headers: getAuthHeaders(),
                body: JSON.stringify({ milestones: [{ name: raceName, date: raceDate, target_ctl: parseFloat(raceCtl || 90), is_main: true }] })
            });
        }

        // 4. Redirect or reload
        if (redirectUrl) {
            window.location.href = redirectUrl;
        } else {
            window.location.reload();
        }
    } catch (e) {
        console.error("Onboarding Save Error:", e);
        alert("There was an issue saving your profile. Please check your connection.");
        if (btn) btn.innerText = "Complete Setup";
    }
}

function saveAndConnectStrava() {
    // If the user clicks Strava, we save their inputs FIRST, then redirect them to the OAuth page.
    const clientId = '208765'; // Your Strava Client ID
    const redirectUri = encodeURIComponent(window.location.origin);
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=activity:read_all,activity:write`;

    completeOnboarding(authUrl);
}
// --- VOICE COACHING FEATURE ---
let isVoiceEnabled = false;
let speechRecognition;
let isRecording = false;
let availableVoices = [];

function toggleSpeaker() {
    isVoiceEnabled = !isVoiceEnabled;
    const btn = document.getElementById('speaker-toggle');
    const icon = document.getElementById('speaker-icon');
    const text = document.getElementById('speaker-text');
    if (isVoiceEnabled) {
        btn.classList.add('bg-theme-accent-soft', 'border-theme-accent-border', 'text-theme-accent');
        btn.classList.remove('bg-theme-bg', 'border-theme-border', 'text-theme-muted');
        text.innerText = 'Voice On';
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5 10c0-1.1.9-2 2-2h2l4-4v16l-4-4H7c-1.1 0-2-.9-2-2z"></path>';
    } else {
        btn.classList.remove('bg-theme-accent-soft', 'border-theme-accent-border', 'text-theme-accent');
        btn.classList.add('bg-theme-bg', 'border-theme-border', 'text-theme-muted');
        text.innerText = 'Voice Off';
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" clip-rule="evenodd" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />';
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
}

if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;

    speechRecognition.onstart = function () {
        isRecording = true;
        const btn = document.getElementById('voice-btn');
        btn.classList.add('text-red-500', 'animate-pulse');
        btn.classList.remove('text-theme-muted');
        document.getElementById('chat-input').placeholder = "Listening...";
    };

    speechRecognition.onresult = function (event) {
        let interimTranscript = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        const input = document.getElementById('chat-input');
        if (finalTranscript) {
            input.value = finalTranscript;
            sendMessage();
        } else {
            input.value = interimTranscript;
        }
    };

    speechRecognition.onerror = function (event) {
        console.error("Speech Recognition Error:", event.error);
        stopRecording();
    };

    speechRecognition.onend = function () {
        stopRecording();
    };
}

function toggleRecording() {
    if (!speechRecognition) {
        alert("Voice recognition is not supported in this browser.");
        return;
    }
    if (isRecording) {
        speechRecognition.stop();
    } else {
        document.getElementById('chat-input').value = '';
        speechRecognition.start();
    }
}

function stopRecording() {
    isRecording = false;
    const btn = document.getElementById('voice-btn');
    if (btn) {
        btn.classList.remove('text-red-500', 'animate-pulse');
        btn.classList.add('text-theme-muted');
    }
    const input = document.getElementById('chat-input');
    if (input) input.placeholder = "Ask about your training...";
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        availableVoices = Array.from(window.speechSynthesis.getVoices());
    };
}

function speakResponse(text, mood, coachTone) {
    if (!isVoiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    // Clean markdown from text before speaking
    const cleanText = text.replace(/[*#_`\[\]]/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanText);

    // Map voice based on coachTone
    let selectedVoice = null;
    const tone = (coachTone || '').toLowerCase();

    // Ensure availableVoices is populated (fallback if onvoiceschanged hasn't fired or was missed)
    if (availableVoices.length === 0) {
        availableVoices = Array.from(window.speechSynthesis.getVoices());
    }

    if (tone.includes('goggins') || tone.includes('intense')) {
        selectedVoice = availableVoices.find(v => v.name.toLowerCase().includes('daniel') || v.name.toLowerCase().includes('uk english male'));
        utterance.pitch = 0.8;
        utterance.rate = 1.05;
    } else if (tone.includes('supportive') || tone.includes('empathetic')) {
        selectedVoice = availableVoices.find(v => v.name.toLowerCase().includes('samantha') || v.name.toLowerCase().includes('karen') || v.name.toLowerCase().includes('us english female'));
        utterance.pitch = 1.1;
        utterance.rate = 0.95;
    } else {
        // Default
        selectedVoice = availableVoices.find(v => v.name.toLowerCase().includes('google us english') || v.lang === 'en-US');
    }

    if (selectedVoice) {
        utterance.voice = selectedVoice;
    }

    window.speechSynthesis.speak(utterance);
}

// Initialize App
document.getElementById('header-date').innerText = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
checkLogin();
checkStravaCallback();

async function submitPhysiqueLog(e) {
    e.preventDefault();
    const btn = document.getElementById('physique-submit-btn');
    btn.disabled = true;
    btn.innerText = 'Saving...';

    const formData = new FormData();
    formData.append('date', document.getElementById('physique-date').value);
    formData.append('weight_kg', document.getElementById('physique-weight').value);
    formData.append('sleep_quality', document.getElementById('physique-sleep').value);
    formData.append('fatigue_level', document.getElementById('physique-fatigue').value);
    formData.append('notes', document.getElementById('physique-notes').value);

    const fileInput = document.getElementById('physique-photo');
    if (fileInput.files.length > 0) {
        formData.append('photo', fileInput.files[0]);
    }

    try {
        const token = localStorage.getItem('nana_token');
        const res = await fetch('/api/physique', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        if (res.ok) {
            document.getElementById('physique-form').reset();
            loadPhysiqueLogs();

            const statusEl = document.getElementById('physique-status');
            if (statusEl) {
                statusEl.innerText = "✅ Saved!";
                statusEl.classList.remove('hidden');
                setTimeout(() => statusEl.classList.add('hidden'), 3000);
            }
        } else {
            alert("Failed to save log.");
        }
    } catch (error) {
        console.error(error);
        alert("An error occurred.");
    } finally {
        btn.disabled = false;
        btn.innerText = 'Save Log';
    }
}

async function loadPhysiqueLogs() {
    try {
        const token = localStorage.getItem('nana_token');
        const res = await fetch('/api/physique', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const logs = await res.json();

        const container = document.getElementById('physique-history');
        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="text-xs text-theme-muted text-center py-4">No logs yet.</div>';
            return;
        }

        container.innerHTML = logs.map(l => `
            <div class="bg-theme-bg md:border border-theme-border md:rounded-lg flex flex-col md:flex-row relative group">
                <div class="flex-1 p-4 md:p-4 space-y-2 relative">
                    <button onclick="deletePhysiqueLog(${l.id})" class="absolute top-4 right-4 text-theme-muted hover:text-red-500 md:opacity-0 group-hover:opacity-100 transition z-10" title="Delete Log">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                    <div class="font-bold text-theme-text">${l.date}</div>
                    <div class="text-sm text-theme-muted grid grid-cols-2 md:grid-cols-3 gap-2">
                        ${l.weight_kg ? `<div><span class="font-bold">Weight:</span> ${l.weight_kg}kg</div>` : ''}
                        ${l.sleep_quality ? `<div><span class="font-bold">Sleep:</span> ${l.sleep_quality}/5</div>` : ''}
                        ${l.fatigue_level ? `<div><span class="font-bold">Fatigue:</span> ${l.fatigue_level}/5</div>` : ''}
                    </div>
                    ${l.notes ? `<div class="text-sm text-theme-text mt-2 p-2 bg-theme-bg-hover rounded border border-theme-border/50">${l.notes}</div>` : ''}
                </div>
                ${l.photo_url ? `
                <div class="w-full md:w-32 flex-shrink-0 md:p-4 md:pl-0">
                    <img src="${l.photo_url}" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full h-[40vh] md:h-32 object-cover md:rounded-lg md:border border-theme-border">
                </div>
                ` : ''}
            </div>
        `).join('');

    } catch (e) {
        console.error(e);
    }
}

async function deletePhysiqueLog(id) {
    if (!id) return;
    try {
        const token = localStorage.getItem('nana_token');
        const res = await fetch(`/api/physique/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            loadPhysiqueLogs();
            loadBiometrics(); // Refresh chart/table
        } else {
            alert("Failed to delete log.");
        }
    } catch (e) {
        console.error(e);
        alert("Error deleting log.");
    }
}

async function loadNutritionProtocol() {
    try {
        document.getElementById('nutrition-loading').classList.remove('hidden');
        document.getElementById('nutrition-content').classList.add('hidden');

        const token = localStorage.getItem('nana_token');
        const res = await fetch('/api/physique/nutrition', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const protocol = await res.json();

        document.getElementById('nutrition-focus-title').innerText = protocol.title || 'Balanced Protocol';
        document.getElementById('nutrition-rationale').innerText = protocol.rationale || '';
        document.getElementById('macro-carbs').innerText = `${protocol.carbs || '--'}g`;
        document.getElementById('macro-protein').innerText = `${protocol.protein || '--'}g`;
        document.getElementById('macro-fat').innerText = `${protocol.fat || '--'}g`;

        document.getElementById('nutrition-loading').classList.add('hidden');
        document.getElementById('nutrition-content').classList.remove('hidden');
    } catch (e) {
        console.error("Failed to load nutrition protocol", e);
        document.getElementById('nutrition-loading').innerText = 'Failed to load';
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // Pre-fill Physique date to today
    const physDate = document.getElementById('physique-date');
    if (physDate) {
        const today = new Date();
        // Adjust for local timezone offset to get correct YYYY-MM-DD
        const offset = today.getTimezoneOffset() * 60000;
        const localDate = new Date(today.getTime() - offset).toISOString().split('T')[0];
        physDate.value = localDate;
    }

    // Initialize Swipe-to-dismiss for Activity Modal Bottom Sheet
    const modalContent = document.getElementById('activity-modal-content');
    if (modalContent && typeof Hammer !== 'undefined') {
        const hammer = new Hammer(modalContent);
        hammer.get('swipe').set({ direction: Hammer.DIRECTION_DOWN });
        hammer.on('swipedown', () => {
            // Only swipe dismiss on mobile (where the bottom sheet is active)
            if (window.innerWidth < 768) {
                closeModal();
            }
        });
    }

    // Initialize Swipe-to-dismiss for Edit Workout Modal Bottom Sheet
    const editModalContent = document.getElementById('edit-workout-modal-content');
    if (editModalContent && typeof Hammer !== 'undefined') {
        const hammerEdit = new Hammer(editModalContent);
        hammerEdit.get('swipe').set({ direction: Hammer.DIRECTION_DOWN });
        hammerEdit.on('swipedown', () => {
            if (window.innerWidth < 768) {
                closeEditWorkoutModal();
            }
        });
    }

    // Hide mobile navigation when keyboard is open using focus events (more reliable across iOS/Android)
    const mainNav = document.getElementById('main-navigation');
    const mainContent = document.getElementById('main-content');

    document.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            if (window.innerWidth < 768) {
                if (mainNav) mainNav.classList.add('hidden');
                if (mainContent) mainContent.classList.remove('pb-24');
            }
        }
    });

    document.addEventListener('focusout', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            if (window.innerWidth < 768) {
                if (mainNav) mainNav.classList.remove('hidden');
                if (mainContent) mainContent.classList.add('pb-24');
            }
        }
    });
});