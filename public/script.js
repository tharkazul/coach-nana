// --- GLOBAL VARIABLES ---
        let currentPlan = {};
        let pmcChartInstance = null;
        let activityMap = null;
        let globalHistoryData = [];
        let currentCoachTone = "Empathetic but demanding elite endurance coach."; // NEW Tracker
        
        function getMonday(d) {
            d = new Date(d);
            var day = d.getDay(), diff = d.getDate() - day + (day == 0 ? -6 : 1); 
            return new Date(d.setDate(diff));
        }
        let viewingWeekStart = getMonday(new Date());

        let globalMilestones = [];

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
            } catch(e) { alert("Failed to save calendar."); }
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

        function checkLogin() {
            const token = localStorage.getItem('nana_token');
            if (token) {
                document.getElementById('login-overlay').style.display = 'none';
                loadSettings(); 
                buildDashboard();
                loadChatHistory();
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
                    
                    // Unhide the Admin Panel button in the sidebar
                    const adminNav = document.getElementById('nav-admin');
                    if (adminNav) {
                        adminNav.classList.remove('hidden');
                    } else {
                        console.error("❌ Could not find 'nav-admin' in the HTML!");
                    }

                    // Unhide the secret Admin-Only coach tone
                    const select = document.getElementById('set-coach-tone');
                    if (select && !select.querySelector('option[value*="madison"]')) {
                        select.innerHTML += `<option value="Flirty, Horny, supportive, as if in a relationship, in the style of Madison Beer.">Coach Madison (Admin Only)</option>`;
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
                    if(banner) banner.classList.add('hidden');
                    if(content) content.classList.remove('hidden');
                }
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
            } catch(e) { 
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
        function switchTab(t) {
            // Safely toggle visibility to prevent missing ID crashes
            const views = ['dashboard', 'coach', 'settings', 'history', 'admin'];
            views.forEach(view => {
                const el = document.getElementById(`view-${view}`);
                if (el) el.classList.toggle('hidden', t !== view);
            });
            
            document.getElementById('current-tab-title').innerText = { 'dashboard': 'Dashboard', 'coach': 'AI Coach', 'settings': 'Athlete Profile', 'history': 'Log' }[t];
            
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

            if(t === 'history') loadHistory();
            if(t === 'coach') {
                setTimeout(() => {
                    const chatWindow = document.getElementById('chat-window');
                    if(chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
                }, 10);
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
                if(macroBlock) macroBlock.classList.add('hidden');
                return;
            }
            
            // 2. Find the main A-Race (fallback to the last race if none selected)
            const mainRace = globalMilestones.find(m => m.is_main) || globalMilestones[globalMilestones.length - 1];
            
            if(macroBlock) macroBlock.classList.remove('hidden');

            const today = new Date();
            const raceDate = new Date(mainRace.date);
            const totalDays = 112; 
            const planStartDate = new Date(raceDate);
            planStartDate.setDate(planStartDate.getDate() - totalDays);

            const taperDays = 14; 
            const peakDays = 21;  
            const buildDays = 28; 
            const baseDays = totalDays - (taperDays + peakDays + buildDays); 

            document.getElementById('phase-base').style.width = `${(baseDays/totalDays)*100}%`;
            document.getElementById('phase-build').style.width = `${(buildDays/totalDays)*100}%`;
            document.getElementById('phase-peak').style.width = `${(peakDays/totalDays)*100}%`;
            document.getElementById('phase-taper').style.width = `${(taperDays/totalDays)*100}%`;

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
            let d = desc.toLowerCase(), tssPerHour = 55, zone = 'Z2';
            if (d.includes('recovery') || d.includes('easy')) { tssPerHour = 35; zone = 'Z1'; } 
            else if (d.includes('threshold') || d.includes('tempo')) { tssPerHour = 80; zone = 'Z3/Z4'; } 
            else if (d.includes('interval') || d.includes('sprint') || d.includes('test')) { tssPerHour = 90; zone = 'Z4/Z5'; }
            let mins = Math.round((tss / tssPerHour) * 60), h = Math.floor(mins / 60), m = mins % 60; let timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
            return `<div class="flex flex-col items-end"><div class="whitespace-nowrap"><span class="text-theme-text font-medium">~${timeStr}</span> <span class="text-[10px] uppercase bg-theme-bg text-theme-muted px-1 py-0.5 rounded-sm border border-theme-border hidden md:inline-block">${zone}</span></div></div>`;
        }

        function getWeatherEmoji(code) {
            if (code === 0) return '☀️'; if (code >= 1 && code <= 3) return '⛅'; if (code >= 45 && code <= 48) return '🌫️'; if (code >= 51 && code <= 67) return '🌧️'; if (code >= 71 && code <= 77) return '❄️'; if (code >= 80 && code <= 82) return '🌦️'; if (code >= 95) return '⛈️'; return '☁️';
        }

        // --- CORE DATA FUNCTIONS ---
        async function buildDashboard() {
            try {
                // 1. Fetch TSS, Weight, AND Milestones
                const [tssRes, weightRes, msRes] = await Promise.all([
                    fetch('/api/dashboard-data', { headers: getAuthHeaders() }), 
                    fetch('/api/weight', { headers: getAuthHeaders() }),
                    fetch('/api/milestones', { headers: getAuthHeaders() })
                ]);
                
                if (!tssRes.ok || !weightRes.ok) return; // Prevent crash if backend is not ready
                
                const data = await tssRes.json(); 
                const weightData = await weightRes.json();
                
                // 2. Store milestones globally for charts & editor
                globalMilestones = msRes.ok ? await msRes.json() : [];
                renderMilestoneEditor(); // Populate the settings tab
                
                // 3. Process Weight & Biometrics Table
                if (weightData && weightData.length > 0) {
                    const sortedData = [...weightData].sort((a,b) => new Date(b.date) - new Date(a.date));
                    const latest = sortedData[0];
                    document.getElementById('latest-weight-metric').innerHTML = `${latest.weight_kg.toFixed(1)} <span class="text-sm text-theme-muted">kg</span>`;

                    let bioHtml = '';
                    sortedData.slice(0, 10).forEach(w => {
                        bioHtml += `<tr class="hover:bg-theme-bg transition">
                            <td class="p-3 md:p-4 text-theme-text">${w.date}</td>
                            <td class="p-3 md:p-4 font-mono text-theme-text text-right">${w.weight_kg ? w.weight_kg.toFixed(1) : '--'}</td>
                            <td class="p-3 md:p-4 font-mono text-theme-muted text-right">${w.body_fat_percent ? w.body_fat_percent.toFixed(1) : '--'}</td>                            
                        </tr>`;
                    });
                    document.getElementById('biometrics-table-body').innerHTML = bioHtml;
                }

                // 4. Prepare dictionaries and set start date
                const tssDict = Object.fromEntries(data.map(d => [d.date, d.daily_tss])); 
                const weightMap = Object.fromEntries(weightData.map(w => [w.date, w.weight_kg]));
                
                let minTssDate = data.length > 0 ? data[0].date : new Date().toISOString().split('T')[0];
                let minWeightDate = weightData.length > 0 ? weightData[0].date : new Date().toISOString().split('T')[0];
                let startDateStr = minTssDate < minWeightDate ? minTssDate : minWeightDate;
                
                let ctl=0, atl=0, d = new Date(startDateStr); 
                const today = new Date();
                const dates=[], ctlData=[], atlData=[], tsbData=[], weightPlot=[], targetData=[], eventMarkerData=[];
                
                // 5. Loop 1: Calculate historical Form, Fitness, and Fatigue up to TODAY
                while(d <= today) {
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
                document.getElementById('ctl-metric').innerText = Math.round(ctl*10)/10; 
                document.getElementById('atl-metric').innerText = Math.round(atl*10)/10;
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
                    ].sort((a,b) => a.date - b.date); 
                    
                    let currentIdx = 0;
                    
                    while(d <= lastDate) {
                        let str = d.toISOString().split('T')[0]; 
                        
                        // Push empty data for actuals since this is the future
                        dates.push(str); 
                        ctlData.push(null); 
                        atlData.push(null); 
                        tsbData.push(null); 
                        weightPlot.push(weightMap[str] || null); 
                        
                        // Linear interpolation for the target line
                        while (currentIdx < controlPoints.length - 1 && d > controlPoints[currentIdx+1].date) currentIdx++;
                        let p1 = controlPoints[currentIdx], p2 = controlPoints[currentIdx+1] || p1, targetCtl = p1.ctl;
                        if (p1.date < p2.date) { 
                            targetCtl = p1.ctl + ((p2.ctl - p1.ctl) * ((d - p1.date) / (p2.date - p1.date))); 
                        }
                        
                        targetData.push(targetCtl); 
                        eventMarkerData.push(globalMilestones.find(m => m.date === str) ? targetCtl : null); 
                        d.setDate(d.getDate() + 1);
                    }
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
                                { label: 'Milestone', data: eventMarkerData, type: 'line', showLine: false, pointStyle: 'star', pointBackgroundColor: '#f59e0b', pointBorderColor: '#d97706', pointRadius: 10, pointHoverRadius: 12, yAxisID: 'y' }, 
                                { label: 'Weight', data: weightPlot, borderColor: '#10b981', borderDash: [2, 2], borderWidth: 2, tension: 0.2, pointRadius: 2, yAxisID: 'yWeight', spanGaps: true } 
                            ] 
                        }, 
                        options: { 
                            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, 
                            scales: { 
                                y: { type: 'linear', position: 'left', grid: { color: 'rgba(156, 163, 175, 0.2)' }, ticks: { color: '#9ca3af', font: { size: 10 } } }, 
                                yWeight: { type: 'linear', position: 'right', min: 85, max: 110, grid: { drawOnChartArea: false }, ticks: { color: '#10b981', font: { size: 10 } } }, 
                                x: { grid: { display: false }, ticks: { maxTicksLimit: 6, color: '#9ca3af', font: { size: 10 } } } 
                            }, 
                            plugins: { 
                                legend: { position: 'bottom', labels: { color: '#9ca3af', usePointStyle: true, boxWidth: 6, font: { size: 11 } } }, 
                                tooltip: { 
                                    callbacks: { 
                                        label: function(context) { 
                                            // Check dynamic global milestones for the tooltip text
                                            if (context.dataset.label === 'Milestone') { 
                                                let ms = globalMilestones.find(m => m.date === context.label); 
                                                if (ms) return `🏁 ${ms.name}`; 
                                            } 
                                            return context.dataset.label + ': ' + (typeof context.raw === 'number' ? Math.round(context.raw*10)/10 : context.raw); 
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
                const currentPlan = {};
                data.forEach(d => {
                    if (!currentPlan[d.date]) currentPlan[d.date] = [];
                    currentPlan[d.date].push(d);
                });
                
                const actualTssMap = Object.fromEntries(actualData.map(d => [d.date, Math.round(d.daily_tss)]));
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
                
                const container = document.getElementById('micro-plan-container'); 
                if (!container) return;

                let weekEnd = new Date(viewingWeekStart);
                weekEnd.setDate(weekEnd.getDate() + 6);
                const opts = { month: 'short', day: 'numeric' };
                document.getElementById('week-range-label').innerText = `${viewingWeekStart.toLocaleDateString('en-US', opts)} - ${weekEnd.toLocaleDateString('en-US', opts)}`;

                let html = '';
                let todayStr = new Date().toISOString().split('T')[0];
                
                // 2. Loop through all 7 days of the week view
                for(let i=0; i<7; i++) {
                    let d = new Date(viewingWeekStart); 
                    d.setDate(d.getDate()+i); 
                    let dateStr = d.toISOString().split('T')[0]; 
                    let dayName = d.toLocaleDateString('en-US', { weekday: 'short' }); 
                    
                    // Get array of workouts, or default to Rest if empty
                    let workoutsForDay = currentPlan[dateStr] || [{sport:'Rest', description:'Active recovery', target_tss:0, details:''}];
                    
                    let isToday = (dateStr === todayStr);
                    let rowClasses = isToday ? "bg-theme-accent-soft" : "hover:bg-theme-bg";

                    // Open Day Container
                    html += `<div id="row-${dateStr}" class="flex flex-col border-b border-theme-border group ${rowClasses} transition py-1">`;
                    
                    // 3. Nested Loop: Draw each sport for this day
                    workoutsForDay.forEach((p, wIdx) => {
                        let humanData = estimateWorkoutDetails(p.sport, p.description, p.target_tss); 
                        let actualTss = actualTssMap[dateStr] || 0; 
                        let actColor = actualTss > 0 ? (actualTss >= (p.target_tss * 0.9) ? 'text-theme-accent font-bold' : 'text-amber-500 font-bold') : 'text-theme-muted';
                        
                        // Only show weather on the first row of the day
                        let weatherHtml = `<div class="w-12 md:w-16 shrink-0"></div>`;
                        if (wIdx === 0 && weatherMap[dateStr]) { 
                            const w = weatherMap[dateStr]; 
                            const precipAlert = w.precip > 0 ? `<span class="text-blue-400">${w.precip}mm</span>` : `<span class="text-theme-muted opacity-50">0mm</span>`; 
                            weatherHtml = `<div class="w-12 md:w-16 flex flex-col items-center justify-center shrink-0 border-l border-theme-border pl-2"><span class="text-lg leading-none">${w.emoji}</span><span class="text-[9px] md:text-[10px] font-mono text-theme-muted mt-1">${w.temp}°C</span><span class="text-[8px] md:text-[9px] font-mono">${precipAlert}</span></div>`; 
                        }
                        
                        let detailsHtml = '';
                        if (p.steps_json && p.steps_json !== '[]' && p.steps_json !== 'null') {
                            try {
                                let steps = JSON.parse(p.steps_json);
                                let stepsList = steps.map(step => {
                                    let dur = step.condition_type === 'time' ? `${step.condition_value} min` : `${step.condition_value}m`;
                                    let tgt = step.zone ? `Zone ${step.zone}` : (step.target_type === 'no.target' ? 'Open' : step.target_type.replace('.zone', ''));
                                    return `<div class="flex justify-between items-center border-b border-theme-border last:border-0 py-1.5"><span class="capitalize font-bold text-theme-text">${step.type}</span><span class="text-theme-muted">${dur} @ <span class="font-bold">${tgt}</span></span></div>`;
                                }).join('');
                                
                                detailsHtml = `<div class="w-full pl-28 md:pl-40 pr-4 md:pr-6 pb-3 pt-0 text-[10px] md:text-[11px] text-theme-muted font-mono leading-relaxed group-hover:bg-theme-bg transition"><div class="border-l-2 border-theme-accent pl-3 py-2 bg-theme-card shadow-sm rounded-r-sm border border-theme-border flex flex-col">${p.details && p.details.trim() !== '' ? `<div class="mb-2 pb-2 border-b border-theme-border italic">${p.details.replace(/\n/g, '<br>')}</div>` : ''}<div class="space-y-0.5">${stepsList}</div></div></div>`;
                            } catch(e) {}
                        } else if (p.details && p.details.trim() !== '') {
                            detailsHtml = `<div class="w-full pl-28 md:pl-40 pr-4 md:pr-6 pb-3 pt-0 text-[10px] md:text-[11px] text-theme-muted font-mono leading-relaxed group-hover:bg-theme-bg transition"><div class="border-l-2 border-theme-accent pl-3 py-1.5 bg-theme-card shadow-sm rounded-r-sm border border-theme-border">${p.details.replace(/\n/g, '<br>')}</div></div>`;
                        }
                        
                        // Only show the Date text on the first row of the day
                        let dateDisplay = wIdx === 0 
                            ? `<span class="text-xs md:text-sm font-medium ${isToday ? 'text-theme-accent font-bold' : 'text-theme-text'}">${dateStr.slice(5)}</span><span class="text-[9px] md:text-[10px] uppercase font-bold ${isToday ? 'text-theme-accent' : 'text-theme-muted'} tracking-wider">${dayName}</span>` 
                            : ``;

                        // NEW: Checkbox HTML (Hidden for Rest days)
                        let isPastDate = (dateStr < todayStr);
                        let cbHtml = (p.sport !== 'Rest' && !isPastDate) 
                            ? `<input type="checkbox" class="garmin-sync-cb cursor-pointer w-4 h-4 accent-theme-accent" data-date="${dateStr}" data-sport="${p.sport}" onchange="toggleGarminBtn()">` 
                            : (p.sport !== 'Rest' ? `<span class="w-4 h-4 block opacity-20 cursor-not-allowed"></span>` : ``);
                
                        html += `
                            <div class="flex items-center px-4 md:px-6 py-2 w-full">
                                <div class="w-8 shrink-0 flex items-center">${cbHtml}</div>
                                <div class="w-24 md:w-32 flex items-center space-x-2 md:space-x-3 shrink-0">${dateDisplay}</div>
                                <span class="w-16 md:w-24 text-xs md:text-sm font-medium ${p.sport==='Rest' ? 'text-theme-muted' : 'text-theme-accent'} shrink-0">${p.sport}</span>
                                <span class="flex-1 text-xs md:text-sm text-theme-text truncate pr-2 md:pr-4 min-w-[120px]">${p.description}</span>
                                <span class="w-28 md:w-36 text-xs md:text-sm text-right pr-2 md:pr-4 shrink-0">${humanData}</span>
                                <div class="w-16 md:w-20 flex flex-col items-end pr-2 md:pr-4 shrink-0 font-mono text-[10px] md:text-xs"><span class="text-theme-muted">Tgt: ${p.target_tss}</span><span class="${actColor}">Act: ${actualTss}</span></div>
                                ${weatherHtml}
                                <button onclick="editDay('${dateStr}', '${dayName}')" class="text-xs text-theme-muted hover:text-theme-accent font-medium md:opacity-0 group-hover:opacity-100 transition shrink-0 p-2 md:p-0 ml-2">Edit</button>
                            </div>
                            ${detailsHtml}
                        `;
                    });

                    // Close Day Container
                    html += `</div>`;
                }
                container.innerHTML = html;
            } catch (e) { console.error("Micro Plan Load Error:", e); }
        }

        function editDay(dateStr, dayName) {
            let p = currentPlan[dateStr] || {sport:'Rest', description:'', target_tss:0, details:''};
            document.getElementById(`row-${dateStr}`).innerHTML = `
                <div class="flex flex-col px-4 md:px-6 py-3 w-full bg-theme-bg border-b border-theme-border">
                    <div class="flex items-center w-full">
                        <div class="w-28 md:w-40 flex items-center space-x-2 md:space-x-3 shrink-0"><span class="text-xs md:text-sm font-medium text-theme-accent">${dateStr.slice(5)}</span><span class="text-[9px] md:text-[10px] uppercase font-bold text-theme-accent tracking-wider">${dayName}</span></div>
                        <select id="s-${dateStr}" class="w-20 md:w-24 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-xs md:text-sm mr-2 md:mr-4 focus:border-theme-accent shrink-0"><option ${p.sport==='Swim'?'selected':''}>Swim</option><option ${p.sport==='Bike'?'selected':''}>Bike</option><option ${p.sport==='Run'?'selected':''}>Run</option><option ${p.sport==='Brick'?'selected':''}>Brick</option><option ${p.sport==='Rest'?'selected':''}>Rest</option></select>
                        <input id="d-${dateStr}" value="${p.description}" placeholder="Title..." class="flex-1 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-xs md:text-sm mr-2 md:mr-4 focus:border-theme-accent min-w-[100px]">
                        <input id="t-${dateStr}" type="number" value="${p.target_tss}" class="w-14 md:w-16 bg-theme-card text-theme-text border border-theme-border rounded-sm p-1 text-xs md:text-sm text-right mr-2 md:mr-6 focus:border-theme-accent shrink-0">
                        <div class="flex space-x-1 md:space-x-2 shrink-0"><button onclick="saveDay('${dateStr}')" class="bg-theme-accent text-white text-[10px] md:text-xs px-2 py-1.5 rounded-sm">Save</button><button onclick="loadMicroPlan()" class="bg-theme-border text-theme-text text-[10px] md:text-xs px-2 py-1.5 rounded-sm">X</button></div>
                    </div>
                    <div class="pl-28 md:pl-40 pr-16 mt-2 w-full">
                        <textarea id="det-${dateStr}" class="w-full bg-theme-card text-theme-text border border-theme-border rounded-sm p-2 text-xs font-mono focus:border-theme-accent min-h-[60px]" placeholder="Workout drills/structure...">${p.details || ''}</textarea>
                    </div>
                </div>`;
        }
        
        async function saveDay(dateStr) { 
            await fetch('/api/micro-plan', { 
             method: 'POST', 
               headers: getAuthHeaders(), 
              body: JSON.stringify({ 
             date: dateStr, 
             sport: document.getElementById(`s-${dateStr}`).value, 
                description: document.getElementById(`d-${dateStr}`).value, 
               target_tss: parseFloat(document.getElementById(`t-${dateStr}`).value),
               details: document.getElementById(`det-${dateStr}`).value
            })
        });
            loadMicroPlan(); 
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
            document.getElementById('activity-modal').classList.remove('hidden'); document.getElementById('modal-loader').classList.remove('hidden'); document.getElementById('modal-content').classList.add('hidden'); document.getElementById('modal-title').innerText = "Connecting to Strava...";
            try {
                const res = await fetch(`/api/activity/${id}`, { headers: getAuthHeaders() }); const data = await res.json();
                document.getElementById('modal-title').innerText = data.name || "Activity Details";
                let hrStr = data.has_heartrate ? `${Math.round(data.average_heartrate)} bpm` : '--'; let elevStr = data.total_elevation_gain ? `${Math.round(data.total_elevation_gain)} m` : '--'; let sufferStr = data.suffer_score || '--'; let distStr = data.distance ? `${(data.distance / 1000).toFixed(2)} km` : '--'; 
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
                document.getElementById('modal-stats').innerHTML = `
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Distance</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${distStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Avg HR</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${hrStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Elevation</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${elevStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Suffer Score</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${sufferStr}</div>
                </div>
                <div class="bg-theme-bg px-4 py-3 border border-theme-border rounded-sm shadow-sm">
                    <div class="text-[9px] md:text-[10px] text-theme-muted uppercase font-bold tracking-wider">Cadence</div>
                    <div class="text-lg md:text-xl font-light text-theme-text">${cadenceStr}</div>
                </div>`;
                if (activityMap) activityMap.remove(); document.getElementById('actual-map').innerHTML = '';
                activityMap = L.map('actual-map', { zoomControl: false }); L.control.zoom({ position: 'bottomright' }).addTo(activityMap); L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' }).addTo(activityMap);
                if (data.map && data.map.summary_polyline) { const coords = decodePolyline(data.map.summary_polyline); if (coords.length > 0) { const polyline = L.polyline(coords, { color: '#0d9488', weight: 4, opacity: 0.8, lineJoin: 'round' }).addTo(activityMap); activityMap.fitBounds(polyline.getBounds(), { padding: [30, 30] }); } } else { activityMap.setView([52.3676, 4.9041], 13); }
                document.getElementById('modal-loader').classList.add('hidden'); document.getElementById('modal-content').classList.remove('hidden'); document.getElementById('modal-content').classList.add('flex');
                setTimeout(() => { activityMap.invalidateSize(); }, 100);
            } catch (e) { document.getElementById('modal-title').innerText = "Error Fetching Data"; document.getElementById('modal-loader').innerHTML = `<span class="text-red-500 font-bold uppercase tracking-widest text-xs">Connection Failed</span>`; }
        }
        
        function closeModal() { document.getElementById('activity-modal').classList.add('hidden'); }

        async function loadHistory() {
            try {
                const res = await fetch('/api/history', { headers: getAuthHeaders() });
                if(!res.ok) return;
                globalHistoryData = await res.json();
                
                const container = document.getElementById('history-list-container');
                if(!container) return;

                container.innerHTML = globalHistoryData.map((x, idx) => {
                    let sportBadge = '';
                    let s = x.sport_type ? x.sport_type.toLowerCase() : '';
                    if (s.includes('run')) sportBadge = `<span class="bg-orange-100 text-orange-700 border border-orange-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Run</span>`;
                    else if (s.includes('swim')) sportBadge = `<span class="bg-blue-100 text-blue-700 border border-blue-200 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">Swim</span>`;
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
                } catch (e) {}
                
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
            
            const moodKey = (mood === 'thinking' || !mood) ? 'default' : mood;
            const imagePath = `/avatars/${persona}-${moodKey}.png`;

            // Optional Fallback logic if the real images are missing
            const fallbackColors = {
                'empathetic': { default: '14b8a6', hype: '10b981', disappointed: 'f43f5e' },
                'strict':     { default: '3b82f6', hype: '2563eb', disappointed: 'dc2626' },
                'cheer':      { default: 'ec4899', hype: 'd946ef', disappointed: 'f43f5e' },
                'madison':      { default: '374151', hype: '111827', disappointed: '7f1d1d' }
            };
            const c = fallbackColors[persona][moodKey] || fallbackColors[persona].default;
            const fallbackUrl = `https://ui-avatars.com/api/?name=Coach&background=${c}&color=fff&size=128`;

            // Try to load the local image; if you haven't uploaded it yet, it will fail silently in the browser 
            // and you can use an onerror attribute in the HTML, but for now we'll just return the path.
            // When you create the images, uncomment the imagePath return!
            
            // return imagePath; 
            return fallbackUrl; 
        }

        async function loadChatHistory() {
            try {
                const res = await fetch('/api/chat/history', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const history = await res.json();
                const chatWindow = document.getElementById('chat-window');
                if(!chatWindow) return;
                
                if (!history || history.length === 0) {
                    chatWindow.innerHTML = `
                        <div class="flex items-end gap-2 md:gap-3">
                            <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                                <img onclick="enlargeAvatar(this.src)" src="${getCoachAvatar('default')}" alt="Coach" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                            </div>
                            <div class="bg-theme-card border border-theme-border text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-bl-sm max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text">
                                <span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>
                                <span class="whitespace-pre-wrap">Systems nominal. I have synchronized your latest profile settings. Ready to get to work?</span>
                            </div>
                        </div>`;
                    return;
                }

                let html = '';
                history.forEach(msg => {
                    if (msg.role === 'user') {
                        html += `
                            <div class="flex justify-end">
                                <div class="bg-theme-accent text-white text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-br-sm max-w-[85%] md:max-w-[75%] shadow-sm">
                                    <span class="whitespace-pre-wrap">${msg.content}</span>
                                </div>
                            </div>`;
                    } else {
                        let avatarImg = getCoachAvatar(msg.mood || 'default');
                        let formattedContent = msg.content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                        html += `
                            <div class="flex items-end gap-2 md:gap-3">
                                <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                                    <img src="${avatarImg}" onclick="enlargeAvatar(this.src)" class="cursor-pointer transition hover:scale-105 w-full h-full object-cover">
                                </div>
                                <div class="bg-theme-card border border-theme-border text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-bl-sm max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text">
                                    <span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>
                                    <span class="whitespace-pre-wrap">${formattedContent}</span>
                                </div>
                            </div>`;
                    }
                });
                chatWindow.innerHTML = html;
                chatWindow.scrollTop = chatWindow.scrollHeight;
            } catch (e) { console.error("Chat History Load Error:", e); }
        }

        async function submitFeedback(event) {
            event.preventDefault(); // Stop page reload
            
            const form = document.getElementById('feedback-form');
            const statusEl = document.getElementById('feedback-status');
            const submitBtn = form.querySelector('button[type="submit"]');
            
            // Package the text and file into a FormData object
            const formData = new FormData(form);
            
            submitBtn.disabled = true;
            submitBtn.innerText = "Sending...";
            statusEl.innerText = "";

            try {
                // Grab your existing auth headers (which contain the correct token)
                const myHeaders = getAuthHeaders();
                // REMOVE the JSON content-type so the browser can auto-set the multipart/form-data boundary for the image
                delete myHeaders['Content-Type'];

                const response = await fetch('/api/feedback', {
                    method: 'POST',
                    headers: myHeaders,
                    body: formData
                });

                const data = await response.json();

                if (response.ok) {
                    statusEl.innerText = "✅ Sent! Thank you.";
                    statusEl.className = "text-xs font-medium text-green-500";
                    form.reset(); 
                    document.getElementById('file-name').innerText = ""; 
                } else {
                    statusEl.innerText = `❌ Error: ${data.error}`;
                    statusEl.className = "text-xs font-medium text-red-500";
                }
            } catch (error) {
                statusEl.innerText = "❌ Network error. Try again.";
                statusEl.className = "text-xs font-medium text-red-500";
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = "Send Feedback";
                setTimeout(() => { if(statusEl.innerText.includes('✅')) statusEl.innerText = ''; }, 5000);
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

        async function sendMessage() {
            const input = document.getElementById('chat-input'); 
            const message = input.value.trim(); 
            if(!message) return;
            
            const chatWindow = document.getElementById('chat-window');
            
            chatWindow.innerHTML += `
                <div class="flex justify-end">
                    <div class="bg-theme-accent text-white text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-br-sm max-w-[85%] md:max-w-[75%] shadow-sm">
                        <span class="whitespace-pre-wrap">${message}</span>
                    </div>
                </div>`;
            
            input.value = ''; 
            input.style.height = '44px';
            chatWindow.scrollTop = chatWindow.scrollHeight; 
            
            const loadId = 'loading-' + Date.now();
            let thinkingAvatar = getCoachAvatar('thinking');
            
            chatWindow.innerHTML += `
                <div class="flex items-end gap-2 md:gap-3" id="${loadId}">
                    <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card">
                        <img src="${thinkingAvatar}" alt="Coach" class="w-full h-full object-cover opacity-70">
                    </div>
                    <div class="bg-theme-card border border-theme-border text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-bl-sm shadow-sm text-theme-text flex items-center gap-1.5 h-[44px]">
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce"></span>
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce" style="animation-delay: 0.15s"></span>
                        <span class="w-1.5 h-1.5 bg-theme-accent rounded-full animate-bounce" style="animation-delay: 0.3s"></span>
                    </div>
                </div>`;
            chatWindow.scrollTop = chatWindow.scrollHeight;

            try {
                const res = await fetch('/api/chat', { 
                    method: 'POST', 
                    headers: getAuthHeaders(), 
                    body: JSON.stringify({ message }) 
                });
                const data = await res.json();
                
                let finalAvatar = getCoachAvatar(data.mood || 'default');
                let formattedContent = data.reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                
                document.getElementById(loadId).outerHTML = `
                    <div class="flex items-end gap-2 md:gap-3">
                        <div class="w-8 h-8 md:w-10 md:h-10 rounded-full shrink-0 overflow-hidden border border-theme-border shadow-sm bg-theme-card transition-all">
                            <img src="${finalAvatar}" alt="Coach" class="w-full h-full object-cover">
                        </div>
                        <div class="bg-theme-card border border-theme-border text-xs md:text-sm p-3 md:p-4 rounded-2xl rounded-bl-sm max-w-[85%] md:max-w-[75%] shadow-sm text-theme-text">
                            <span class="text-theme-accent font-bold block mb-1 text-[10px] md:text-xs uppercase tracking-wide">Spark</span>
                            <span class="whitespace-pre-wrap">${formattedContent}</span>
                        </div>
                    </div>`;
                    
                chatWindow.scrollTop = chatWindow.scrollHeight;
                if (data.planUpdated) { loadMicroPlan(); }
                
            } catch (error) { 
                document.getElementById(loadId).outerHTML = `
                    <div class="flex justify-center my-4">
                        <div class="bg-red-900 border border-red-700 text-xs px-3 py-1.5 rounded-full text-red-100 shadow-sm">
                            Connection interrupted. Please try again.
                        </div>
                    </div>`; 
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

// --- ADMIN FEEDBACK LOGIC ---
    async function loadAdminFeedback() {
        try {
            const response = await fetch('/api/admin/feedback', {
            headers: getAuthHeaders() // <-- Use your built-in auth function!
            });

            if (!response.ok) return; 

            const data = await response.json();
            const tbody = document.getElementById('admin-feedback-table');
            
            if (!tbody) {
                console.error("Admin table body not found in HTML!");
                return;
            }

            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-8 text-center text-theme-muted">No feedback yet. You're doing great!</td></tr>`;
                return;
            }

            tbody.innerHTML = data.map(f => {
                const date = new Date(f.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                let imageHtml = '<span class="text-theme-muted text-[10px]">None</span>';
                
                if (f.image_path) {
                    const imgUrl = `/${f.image_path.replace(/\\/g, '/')}`; 
                    imageHtml = `<button onclick="enlargeAvatar('${imgUrl}')" class="text-theme-accent hover:underline text-xs font-bold transition">🖼️ View</button>`;
                }

                return `
                    <tr class="hover:bg-theme-bg transition border-b border-theme-border last:border-0">
                        <td class="px-4 py-3 text-xs whitespace-nowrap text-theme-muted">${date}</td>
                        <td class="px-4 py-3 font-medium text-xs">${f.username || 'Unknown'}</td>
                        <td class="px-4 py-3 text-xs leading-relaxed opacity-90">${f.text}</td>
                        <td class="px-4 py-3 text-center">${imageHtml}</td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error("Failed to load admin feedback", error);
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

    const tone = document.getElementById('onboard-tone').value;
    const context = document.getElementById('onboard-context').value;
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
        // Initialize App
        document.getElementById('header-date').innerText = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        checkLogin();
        checkStravaCallback();