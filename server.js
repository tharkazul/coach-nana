require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { GarminConnect } = require('@flow-js/garmin-connect');
const multer = require('multer');

// --- GEMINI LOAD BALANCER REGISTRY ---
const geminiConfigs = [
    { 
        name: "Primary",
        model: "gemini-3.5-flash", 
        apiKey: process.env.GEMINI_API_KEY 
    },
    { 
        name: "Backup",
        model: "gemini-2.5-flash", 
        apiKey: process.env.GEMINI_API_KEY_BACKUP || process.env.GEMINI_API_KEY 
    }
];

const app = express();
const upload = multer({ dest: 'uploads/' });
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; 
const IV_LENGTH = 16; 

app.use('/uploads', express.static('uploads'));
app.use(bodyParser.json());
app.use(express.static('public'));

// --- CRYPTO UTILITIES ---
function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decipher.final()]);
    return decrypted.toString();
}

// --- AI ENGINE WITH FALLBACK ---
async function generateWithFallback(prompt, systemInstruction = null, chatHistory = null) {
    let lastError = null;
    for (let i = 0; i < geminiConfigs.length; i++) {
        const config = geminiConfigs[i];
        try {
            console.log(`🤖 Attempting AI generation with ${config.name} (${config.model})...`);
            const genAI = new GoogleGenerativeAI(config.apiKey);
            const modelOptions = { model: config.model };
            if (systemInstruction) {
                modelOptions.systemInstruction = systemInstruction;
            }
            const model = genAI.getGenerativeModel(modelOptions);
            let result;
            if (chatHistory) {
                const chat = model.startChat({ history: chatHistory });
                result = await chat.sendMessage(prompt);
            } else {
                result = await model.generateContent(prompt);
            }
            console.log(`✅ AI Success using ${config.name}!`);
            return result.response.text(); 
        } catch (error) {
            console.warn(`⚠️ ${config.name} failed. Reason: ${error.message}`);
            lastError = error;
        }
    }
    console.error("❌ CRITICAL: All Gemini fallback models failed.");
    throw new Error("Coach Spark is currently catching their breath. Please try again in a moment.");
}

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database('./nana_multi.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password_hash TEXT, 
        strava_refresh_token TEXT, 
        garmin_username TEXT, 
        garmin_password TEXT, 
        coach_tone TEXT DEFAULT 'Empathetic but demanding elite endurance coach.', 
        athlete_context TEXT DEFAULT 'No context provided yet.'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS strava_tokens (
        user_id INTEGER PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        strava_id TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);    
    db.run(`CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, sport_type TEXT, distance_km REAL, elevation_m INTEGER, moving_time_min REAL, average_heartrate REAL, start_date TEXT, tss REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS micro_plan (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_tss REAL, details TEXT, steps_json TEXT, UNIQUE(user_id, date))`);
    db.run(`CREATE TABLE IF NOT EXISTS weight_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, weight_kg REAL, body_fat_percent REAL, bmi REAL, lean_mass_kg REAL, UNIQUE(user_id, date))`);
    db.run(`CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, role TEXT, content TEXT, mood TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS athlete_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, metric TEXT, value TEXT, UNIQUE(user_id, metric))`);
    db.run(`CREATE TABLE IF NOT EXISTS biometrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        weight_kg REAL,
        body_fat_percent REAL,
        bmi REAL,
        lean_mass_kg REAL,
        UNIQUE(user_id, date),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        date TEXT,
        target_ctl REAL,
        is_main INTEGER DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
});

// --- AUTHENTICATION MIDDLEWARE ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (token == null) return res.status(401).json({ error: "No token provided" });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token" });
        req.user = user; 
        next();
    });
}

// --- GARMIN MAPPING CONSTANTS ---
const SPORT_MAP = {
    'Run': { sportTypeId: 1, sportTypeKey: "running" },
    'Bike': { sportTypeId: 2, sportTypeKey: "cycling" },
    'Swim': { sportTypeId: 4, sportTypeKey: "swimming" } 
};
const STEP_TYPE_MAP = {
    'warmup': { id: 1, key: "warmup" },
    'cooldown': { id: 2, key: "cooldown" },
    'interval': { id: 3, key: "interval" },
    'recovery': { id: 4, key: "recovery" }
};
const TARGET_TYPE_MAP = {
    'no.target': { id: 1, key: "no.target" },
    'power.zone': { id: 2, key: "power.zone" },
    'heart.rate.zone': { id: 4, key: "heart.rate.zone" },
    'speed.zone': { id: 5, key: "speed.zone" },
    'pace.zone': { id: 6, key: "pace.zone" }
};
const CONDITION_TYPE_MAP = {
    'time': { id: 2, key: "time" },
    'distance': { id: 3, key: "distance" },
    'lap.button': { id: 1, key: "lap.button" }
};

// --- STRAVA WEBHOOK VERIFICATION (HANDSHAKE) ---
app.get('/webhook/strava', (req, res) => {
    const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || "STRAVA";           
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('🔗 Strava Webhook Handshake Verified Successfully.');
            res.json({ "hub.challenge": challenge });
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook/strava', (req, res) => {
    const { aspect_type, object_id, owner_id, object_type } = req.body;
    if (aspect_type === 'create' && object_type === 'activity') {
        console.log(`🏃 Automated hook triggered: Fetching Strava ID ${object_id}`);
        getStravaActivity(owner_id, object_id);
    }
    res.status(200).send('EVENT_RECEIVED');
});

// --- PROFILE & AUTH ENDPOINTS ---
app.post('/api/auth/register', async (req, res) => {
    const { username, password, context } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (username, password_hash, athlete_context) VALUES (?, ?, ?)`, 
            [username, hashedPassword, context || 'New athlete.'], 
            function(err) {
                if (err) return res.status(400).json({ error: "Username might already exist." });
                res.status(201).json({ message: "Athlete registered successfully!", userId: this.lastID });
            }
        );
    } catch (error) {
        res.status(500).json({ error: "Registration failed." });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: "Athlete not found." });
        if (await bcrypt.compare(password, user.password_hash)) {
            const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
            res.json({ token, message: "Welcome to Spark HQ" });
        } else {
            res.status(401).json({ error: "Incorrect password." });
        }
    });
});

app.get('/api/micro-plan', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM micro_plan WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database read failure" });
        res.json(rows || []);
    });
});

app.get('/api/chat/history', authenticateToken, (req, res) => {
    db.all(`SELECT role, content, mood FROM chat_history WHERE user_id = ? ORDER BY id ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load chat history." });
        res.json(rows || []);
    });
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    db.get(`SELECT coach_tone, athlete_context FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Failed to load athlete context." });
        
        db.all(`SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC`, [req.user.id], async (err, historyRows) => {
            if (err) return res.status(500).json({ error: "Database error" });
            
            let cleanHistory = [];
            (historyRows || []).forEach(row => {
                let currentRole = row.role === 'coach' ? 'model' : 'user';
                if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === currentRole) {
                    cleanHistory[cleanHistory.length - 1].parts[0].text += "\n\n" + row.content;
                } else {
                    cleanHistory.push({ role: currentRole, parts: [{ text: row.content }] });
                }
            });

            if (cleanHistory.length > 0 && cleanHistory[0].role !== 'user') cleanHistory.shift();
            if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'user') cleanHistory.pop();

            const todayStr = new Date().toISOString().split('T')[0];
            const next7Days = Array.from({length: 7}, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() + i);
                return `${d.toLocaleDateString('en-US', {weekday: 'long'})}: ${d.toISOString().split('T')[0]}`;
            }).join(', ');

            const systemPrompt = `You are Spark, an elite Ironman Triathlon coach. Today is ${todayStr}. Upcoming Reference: ${next7Days}...`;

            try {
                let aiReply = await generateWithFallback(message, systemPrompt, cleanHistory);
                let planUpdated = false;
                const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
                
                if (jsonMatch) {
                    try {
                        const planData = JSON.parse(jsonMatch[1]);
                        const affectedDates = [...new Set(planData.map(day => day.date))];
                        if (affectedDates.length > 0) {
                            const placeholders = affectedDates.map(() => '?').join(',');
                            db.run(`DELETE FROM micro_plan WHERE user_id = ? AND date IN (${placeholders})`, [req.user.id, ...affectedDates], (err) => {
                                if (err) console.error(err);
                                const stmt = db.prepare(`INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                                planData.forEach(day => {
                                    stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
                                });
                                stmt.finalize();
                            });
                        }
                        planUpdated = true;
                        aiReply = aiReply.replace(/```json[\s\S]*?```/, '').trim();
                    } catch(e) {
                        console.error("JSON parse mismatch", e);
                    }
                }

                let mood = 'default';
                const lowerReply = aiReply.toLowerCase();
                if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
                
                db.run(`INSERT INTO chat_history (user_id, role, content) VALUES (?, 'user', ?)`, [req.user.id, message]);
                db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`, [req.user.id, aiReply, mood]);
                res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });
            } catch (error) {
                res.status(500).json({ error: "AI pipeline error" });
            }
        });
    });
});

app.get('/api/user/settings', authenticateToken, (req, res) => {
    db.get(`SELECT username, strava_refresh_token, garmin_username, coach_tone, athlete_context FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Failed to load settings." });
        res.json({
            username: user.username,
            hasStrava: !!user.strava_refresh_token,
            hasGarmin: !!user.garmin_username,
            garminUsername: user.garmin_username || '',
            coachTone: user.coach_tone,
            athleteContext: user.athlete_context
        });
    });
});

app.post('/api/user/settings/coach', authenticateToken, (req, res) => {
    const { coachTone, athleteContext } = req.body;
    db.run(`UPDATE users SET coach_tone = ?, athlete_context = ? WHERE id = ?`, [coachTone, athleteContext, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: "Failed to update coach settings." });
        res.json({ message: "Coach updated successfully!" });
    });
});

app.post('/api/user/settings/garmin', authenticateToken, (req, res) => {
    const { garminUsername, garminPassword } = req.body;
    if (!garminUsername || !garminPassword) return res.status(400).json({ error: "Required fields missing." });
    const encryptedPassword = encrypt(garminPassword);
    db.run(`UPDATE users SET garmin_username = ?, garmin_password = ? WHERE id = ?`, [garminUsername, encryptedPassword, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: "Failed to save Garmin credentials." });
        res.json({ message: "Garmin connection secured successfully!" });
    });
});

app.post('/api/user/settings/strava', authenticateToken, (req, res) => {
    const { stravaRefreshToken } = req.body;
    if (!stravaRefreshToken) return res.status(400).json({ error: "Missing token." });
    db.run(`UPDATE users SET strava_refresh_token = ? WHERE id = ?`, [stravaRefreshToken, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: "Failed to save Strava integration." });
        res.json({ message: "Strava connected successfully!" });
    });
});

app.post('/api/sync-strava', authenticateToken, async (req, res) => {
    db.get('SELECT strava_refresh_token FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err || !user || !user.strava_refresh_token) return res.status(400).json({ error: "Strava integration inactive." });
        try {
            const tokenRes = await fetch('https://www.strava.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: process.env.STRAVA_CLIENT_ID,
                    client_secret: process.env.STRAVA_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: user.strava_refresh_token
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error("Token refresh error");

            const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            const activities = await actRes.json();
            activities.forEach(act => {
                const tss = act.suffer_score || Math.round((act.moving_time / 3600) * 50);
                db.run(`INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [act.id, req.user.id, act.name, act.sport_type, act.distance / 1000, act.total_elevation_gain, act.moving_time / 60, act.average_heartrate || 0, act.start_date, tss]);
                tagStravaActivity(req.user.id, act, tokenData.access_token);
            });
            res.json({ message: `Successfully synced ${activities.length} activities!` });
        } catch (err) {
            res.status(500).json({ error: "Sync pipeline exception" });
        }
    });
});

app.get('/api/activity/:id', authenticateToken, (req, res) => {
    const activityId = req.params.id;
    db.get('SELECT strava_refresh_token FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err || !user || !user.strava_refresh_token) return res.status(400).json({ error: "Integration inactive." });
        try {
            const tokenRes = await fetch('https://www.strava.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: process.env.STRAVA_CLIENT_ID,
                    client_secret: process.env.STRAVA_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: user.strava_refresh_token
                })
            });
            const tokenData = await tokenRes.json();
            const actRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            const activityData = await actRes.json();
            res.json(activityData);
        } catch (err) {
            res.status(500).json({ error: "Error loading structural metrics" });
        }
    });
});

app.post('/api/user/settings/strava-exchange', authenticateToken, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "No validation token received." });
    try {
        const response = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code'
            })
        });
        const data = await response.json();
        if (data.errors) return res.status(400).json({ error: "Strava handshake error." });
        
        db.run(`UPDATE users SET strava_refresh_token = ? WHERE id = ?`, [data.refresh_token, req.user.id]);
        db.run(`INSERT OR REPLACE INTO strava_tokens (user_id, access_token, refresh_token, expires_at, strava_id) VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, data.access_token, data.refresh_token, data.expires_at, String(data.athlete.id)], (err) => {
                if (err) return res.status(500).json({ error: "Database linking error." });
                res.json({ message: "Strava mapping built cleanly!" });
            });
    } catch (error) {
        res.status(500).json({ error: "Oauth workflow context broken." });
    }
});

app.get('/api/dashboard-data', authenticateToken, (req, res) => {
    db.all(`SELECT substr(start_date, 1, 10) as date, SUM(tss) as daily_tss FROM activities WHERE user_id = ? GROUP BY date ORDER BY date ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database aggregation failure" });
        res.json(rows || []);
    });
});

app.get('/api/history', authenticateToken, (req, res) => {
    db.all(`SELECT id, name, sport_type, start_date, tss FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 50`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "History read exception" });
        res.json(rows || []);
    });
});

app.post('/api/micro-plan', authenticateToken, (req, res) => {
    const { date, sport, description, target_tss, details } = req.body;
    db.run(`INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET sport=excluded.sport, description=excluded.description, target_tss=excluded.target_tss, details=excluded.details`,
        [req.user.id, date, sport, description, target_tss, details], (err) => {
            if (err) return res.status(500).json({ error: "Plan update error" });
            res.json({ success: true });
        });
});

app.post('/api/generate-plan', authenticateToken, async (req, res) => {
    const { targetDate } = req.body;
    db.get(`SELECT coach_tone, athlete_context, training_phase, current_ctl, current_atl FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Athlete identity unresolved." });
        const ctl = user.current_ctl || 0;
        const atl = user.current_atl || 0;
        const tsb = ctl - atl;
        const phase = user.training_phase || 'Base';

        const systemPrompt = `You are Coach Spark...`;
        const userPrompt = `Generate a 7-day layout from ${targetDate} with TSB ${tsb}...`;

        try {
            let aiReply = await generateWithFallback(userPrompt, systemPrompt);
            const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
            if (jsonMatch) {
                const planData = JSON.parse(jsonMatch[1]);
                const affectedDates = [...new Set(planData.map(day => day.date))];
                if (affectedDates.length > 0) {
                    const placeholders = affectedDates.map(() => '?').join(',');
                    db.run(`DELETE FROM micro_plan WHERE user_id = ? AND date IN (${placeholders})`, [req.user.id, ...affectedDates], (err) => {
                        const stmt = db.prepare(`INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                        planData.forEach(day => {
                            stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
                        });
                        stmt.finalize();
                    });
                }
                aiReply = aiReply.replace(/```json[\s\S]*?```/, '').trim();
            }
            res.json({ reply: aiReply, planUpdated: true });
        } catch(e) {
            res.status(500).json({ error: "Planning module timeline breakdown" });
        }
    });
});

app.post('/api/feedback', authenticateToken, upload.single('feedbackImage'), (req, res) => {
    const feedbackText = req.body.text;
    const imagePath = req.file ? req.file.path : null;
    if (!feedbackText) return res.status(400).json({ error: "Content missing" });
    db.run(`INSERT INTO feedback (user_id, text, image_path, created_at) VALUES (?, ?, ?, ?)`, [req.user.id, feedbackText, imagePath, new Date().toISOString()], (err) => {
        if (err) return res.status(500).json({ error: "Feedback dropped" });
        res.json({ message: "Feedback saved!" });
    });
});

app.get('/api/admin/feedback', authenticateToken, (req, res) => {
    db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user || user.username.toLowerCase() !== 'rutger') return res.status(403).json({ error: "Denied" });
        db.all(`SELECT f.id, f.text, f.image_path, f.created_at, u.username FROM feedback f LEFT JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC`, [], (err, rows) => {
            res.json(rows || []);
        });
    });
});

app.post('/api/sync-garmin', authenticateToken, async (req, res) => {
    const selectedWorkouts = req.body.workouts;
    if (!selectedWorkouts || selectedWorkouts.length === 0) return res.status(400).json({ error: "Selection empty" });
    try {
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT garmin_username, garmin_password FROM users WHERE id = ?`, [req.user.id], (err, row) => {
                if (err || !row) reject(err); else resolve(row);
            });
        });
        const decryptedPassword = decrypt(user.garmin_password);
        const GCClient = new GarminConnect({ username: user.garmin_username, password: decryptedPassword });
        await GCClient.login(user.garmin_username, decryptedPassword);
        const client = GCClient.client || GCClient.http;

        const todayStr = new Date().toISOString().split('T')[0];
        const workouts = await new Promise((resolve, reject) => {
            db.all(`SELECT date, sport, description, target_tss, steps_json FROM micro_plan WHERE user_id = ? AND date >= ?`, [req.user.id, todayStr], (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });

        const workoutsToSync = workouts.filter(w => selectedWorkouts.some(sw => sw.date === w.date && sw.sport === w.sport));
        let syncedCount = 0;

        for (const workout of workoutsToSync) {
            if (workout.sport === 'Rest' || !SPORT_MAP[workout.sport]) continue;
            let stepsArray = [];
            try { stepsArray = JSON.parse(workout.steps_json); } catch(e) { stepsArray = []; }
            if (stepsArray.length === 0) {
                stepsArray = [{ type: 'interval', condition_type: 'time', condition_value: 45, target_type: 'no.target' }];
            }

            const garminSteps = stepsArray.map((step, index) => {
                const stepDef = STEP_TYPE_MAP[step.type] || STEP_TYPE_MAP['interval'];
                const targetDef = TARGET_TYPE_MAP[step.target_type] || TARGET_TYPE_MAP['no.target'];
                const conditionDef = CONDITION_TYPE_MAP[step.condition_type] || CONDITION_TYPE_MAP['time'];
                return {
                    type: "ExecutableStepDTO",
                    stepOrder: index + 1,
                    stepType: { stepTypeId: stepDef.id, stepTypeKey: stepDef.key },
                    endCondition: { conditionTypeId: conditionDef.id, conditionTypeKey: conditionDef.key },
                    endConditionValue: step.condition_type === 'time' ? step.condition_value * 60 : step.condition_value,
                    targetType: { workoutTargetTypeId: targetDef.id, workoutTargetTypeKey: targetDef.key },
                    targetValueOne: null, targetValueTwo: null,
                    zoneNumber: step.zone ? parseInt(step.zone, 10) : null 
                };
            });

            const wkt = {
                workoutName: `Spark: ${workout.sport}`,
                sportType: SPORT_MAP[workout.sport],
                workoutSegments: [{ segmentOrder: 1, sportType: SPORT_MAP[workout.sport], workoutSteps: garminSteps }]
            };

            const response = await client.post('https://connectapi.garmin.com/workout-service/workout', wkt);
            const workoutId = response?.workoutId || response?.data?.workoutId;
            if (workoutId) {
                await client.post(`https://connectapi.garmin.com/workout-service/schedule/${workoutId}`, { date: workout.date });
                syncedCount++;
            }
        }
        res.json({ message: `Synced ${syncedCount} workouts!` });
    } catch (err) {
        res.status(500).json({ error: "Garmin upload timeout" });
    }
});

app.get('/api/milestones', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM milestones WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/milestones', authenticateToken, (req, res) => {
    const { milestones } = req.body;
    db.serialize(() => {
        db.run(`DELETE FROM milestones WHERE user_id = ?`, [req.user.id]);
        const stmt = db.prepare(`INSERT INTO milestones (user_id, name, date, target_ctl, is_main) VALUES (?, ?, ?, ?, ?)`);
        milestones.forEach(m => stmt.run(req.user.id, m.name, m.date, m.target_ctl, m.is_main ? 1 : 0));
        stmt.finalize();
        res.json({ success: true });
    });
});

app.post('/api/weight', authenticateToken, (req, res) => {
    const { date, weight_kg, body_fat_percent, bmi, lean_mass_kg } = req.body;
    db.run(`INSERT INTO biometrics (user_id, date, weight_kg, body_fat_percent, bmi, lean_mass_kg) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg=excluded.weight_kg, body_fat_percent=excluded.body_fat_percent, bmi=excluded.bmi, lean_mass_kg=excluded.lean_mass_kg`,
        [req.user.id, date, weight_kg, body_fat_percent, bmi, lean_mass_kg], (err) => {
            if (err) return res.status(500).json({ error: "Failed" });
            res.json({ success: true });
        });
});

app.get('/api/weight', authenticateToken, (req, res) => {
    db.all(`SELECT date, weight_kg, body_fat_percent, bmi, lean_mass_kg FROM biometrics WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

// --- ENGINE RECONCILIATION SUBSYSTEMS ---
async function getStravaTokenForUser(userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT strava_refresh_token FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err || !user || !user.strava_refresh_token) return reject("Missing metadata context");
            try {
                const tokenRes = await fetch('https://www.strava.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: process.env.STRAVA_CLIENT_ID,
                        client_secret: process.env.STRAVA_CLIENT_SECRET,
                        grant_type: 'refresh_token',
                        refresh_token: user.strava_refresh_token
                    })
                });
                const tokenData = await tokenRes.json();
                if (tokenData.access_token) resolve(tokenData.access_token);
                else reject("Refresh cycle token rejected");
            } catch(e) { reject(e); }
        });
    });
}

function mapStravaSportToSpark(stravaSport) {
    if (!stravaSport) return 'Other';
    if (stravaSport.includes('Run')) return 'Run';
    if (stravaSport.includes('Ride') || stravaSport.includes('VirtualRide')) return 'Bike';
    if (stravaSport.includes('Swim')) return 'Swim';
    return 'Other';
}

async function tagStravaActivity(userId, activity, token) {
    if (activity.description && activity.description.includes("Coach Spark Target")) return;
    const tss = activity.suffer_score || Math.round((activity.moving_time / 3600) * 50);
    const activityDate = activity.start_date_local ? activity.start_date_local.split('T')[0] : activity.start_date.split('T')[0];
    const sparkSport = mapStravaSportToSpark(activity.sport_type || activity.type);

    db.get("SELECT description, target_tss, details FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?", [userId, activityDate, sparkSport], async (err, plan) => {
        if (err || !plan) return;
        const newDescription = `Coach Spark Target: ${plan.target_tss} TSS\nActual: ${tss} TSS\n\nPlanned:\n${plan.description}`;
        const finalDescription = activity.description ? `${activity.description}\n\n---\n${newDescription}` : newDescription;
        try {
            await fetch(`https://www.strava.com/api/v3/activities/${activity.id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: finalDescription })
            });
        } catch(e) { console.error("Tagging failure", e); }
    });
}

async function getStravaActivity(stravaAthleteId, activityId) {
    try {
        // Resolve mapped user using internal token cross-referencing
        const internalUser = await new Promise((resolve, reject) => {
            db.get(`SELECT user_id FROM strava_tokens WHERE strava_id = ? OR CAST(strava_id AS TEXT) = ?`, [String(stravaAthleteId), String(stravaAthleteId)], (err, row) => {
                if (err || !row) resolve({ user_id: 1 }); // Fallback boundary safeguard
                else resolve(row);
            });
        });

        const token = await getStravaTokenForUser(internalUser.user_id);
        const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        const tss = data.suffer_score || Math.round((data.moving_time / 3600) * 50);

        db.run(`INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tss=excluded.tss`,
            [data.id, internalUser.user_id, data.name, data.sport_type, data.distance / 1000, data.total_elevation_gain, data.moving_time / 60, data.average_heartrate || 0, data.start_date, tss]);

        const activityDate = data.start_date_local ? data.start_date_local.split('T')[0] : data.start_date.split('T')[0];
        const sparkSport = mapStravaSportToSpark(data.sport_type);

        db.get("SELECT description, target_tss, details FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?", [internalUser.user_id, activityDate, sparkSport], async (err, plan) => {
            if (err || !plan) return;
            const newDescription = `Coach Spark Target: ${plan.target_tss} TSS\nActual: ${tss} TSS...`;
            await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: newDescription })
            });
        });
    } catch (e) { console.error("Webhook ingestion failure", e); }
}

async function syncAllStravaUsersOnStartup() {
    db.all('SELECT id FROM users WHERE strava_refresh_token IS NOT NULL', [], async (err, users) => {
        if (err || !users) return;
        for (const user of users) {
            try {
                const token = await getStravaTokenForUser(user.id);
                const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=50', { headers: { 'Authorization': `Bearer ${token}` } });
                const activities = await actRes.json();
                activities.forEach(act => {
                    const tss = act.suffer_score || Math.round((act.moving_time / 3600) * 50);
                    db.run(`INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [act.id, user.id, act.name, act.sport_type, act.distance / 1000, act.total_elevation_gain, act.moving_time / 60, act.average_heartrate || 0, act.start_date, tss]);
                    tagStravaActivity(user.id, act, token);
                });
            } catch (err) { console.error(err); }
        }
    });
}

// --- SINGLE EXPLICIT APPLICATION ENTRYPOINT BINDING ---
app.listen(process.env.PORT || 3001, () => {
    console.log('🚀 Spark HQ Multi-Tenant Engine live on port 3001...');
    syncAllStravaUsersOnStartup(); 
});