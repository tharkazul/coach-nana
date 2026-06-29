require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const crypto = require('crypto');
const { GarminConnect } = require('@flow-js/garmin-connect');
const multer = require('multer');
const app = express();
const upload = multer({ dest: 'uploads/' });

// This key MUST be exactly 32 bytes (256 bits). 
// In production, move this to your .env file!
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; 
const IV_LENGTH = 16; // For AES, this is always 16 bytes



 

// Optional but recommended: Serve the uploads folder so you (the admin) can view the images later
app.use('/uploads', express.static('uploads'));


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


app.use(bodyParser.json());
app.use(express.static('public'));

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database('./nana_multi.db');

db.serialize(() => {
    // 1. The Master Users Table
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
    // 2. Multi-Tenant Activity Tables (Notice the UNIQUE constraints combining user_id and date)
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
// This function acts as a bouncer. It checks the token before letting a user see their data.
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN_STRING"

    if (token == null) return res.status(401).json({ error: "No token provided" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token" });
        req.user = user; // Attaches the user { id, username } to the request!
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

// --- AUTH ROUTES ---
app.post('/webhook/strava', (req, res) => {
    const { aspect_type, object_id, owner_id } = req.body;
    // If it's a new activity, trigger the sync
    if (aspect_type === 'create') {
        getStravaActivity(owner_id, object_id);
    }
    res.status(200).send('EVENT_RECEIVED');
});

// Register a new friend
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

// Login and get a token
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: "Athlete not found." });

        if (await bcrypt.compare(password, user.password_hash)) {
            // Give them a VIP pass (token) valid for 30 days
            const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
            res.json({ token, message: "Welcome to Coach Nana HQ" });
        } else {
            res.status(401).json({ error: "Incorrect password." });
        }
    });
});

// --- PROTECTED DATA ROUTE EXAMPLE ---
// Notice how we use `authenticateToken` and `req.user.id`
app.get('/api/micro-plan', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM micro_plan WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

// --- GET CHAT HISTORY FOR UI ---
app.get('/api/chat/history', authenticateToken, (req, res) => {
    // Fetches the entire conversation for the frontend to render
    db.all(`SELECT role, content, mood FROM chat_history WHERE user_id = ? ORDER BY id ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load chat history." });
        res.json(rows || []);
    });
});

// --- MULTI-TENANT AI CHAT ROUTE (LIVE GEMINI ENGINE) ---
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;

    db.get(`SELECT coach_tone, athlete_context FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Failed to load athlete context." });

        try {
            // Grabs the last 12 messages in chronological order
            db.all(`SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC`, [req.user.id], async (err, historyRows) => {
                
                // --- THE BULLETPROOF HISTORY SANITIZER ---
                let cleanHistory = [];
                
                (historyRows || []).forEach(row => {
                    let currentRole = row.role === 'coach' ? 'model' : 'user';
                    
                    if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === currentRole) {
                        // Merge consecutive messages of the same role to prevent API crash
                        cleanHistory[cleanHistory.length - 1].parts[0].text += "\n\n" + row.content;
                    } else {
                        // Add as a new message block
                        cleanHistory.push({
                            role: currentRole,
                            parts: [{ text: row.content }]
                        });
                    }
                });

                // Enforce API Start/End Rules
                if (cleanHistory.length > 0 && cleanHistory[0].role !== 'user') {
                    cleanHistory.shift(); // Must start with user
                }
                if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'user') {
                    cleanHistory.pop(); // Must end with model
                }
                // -----------------------------------------

                const todayStr = new Date().toISOString().split('T')[0];
                const next7Days = Array.from({length: 7}, (_, i) => {
                    const d = new Date();
                    d.setDate(d.getDate() + i);
                    return `${d.toLocaleDateString('en-US', {weekday: 'long'})}: ${d.toISOString().split('T')[0]}`;
                }).join(', ');
                
                const systemPrompt = 
                    `You are Coach Nana, an elite Ironman Triathlon and endurance coach. 
                    Today is ${todayStr}.
                    Upcoming Calendar Reference: ${next7Days}
                    Athlete Context: ${user.athlete_context || 'General endurance athlete'}
                    Your Tone & Persona: ${user.coach_tone || 'empathetic'}

                    CRITICAL RULES:
                    1. Act like a real human in a continuous text message thread: keep your responses concise, focused, and natural.
                    2. NEVER repeat your previous greetings, praises, or paragraphs verbatim. Do not bring up old topics unless the athlete explicitly mentions them.
                    3. Always use metric measurements exclusively (meters for distance, km/h for speed, min/km for pace). Never use imperial units.
                    4. Respond directly with your conversational text. Do not wrap your main reply in JSON.
                    5. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout (e.g., Bike + Run), you MUST create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.

                    WORKOUT PLANNING (CRITICAL):
                    If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
                    The JSON must be a valid Array of objects. Format it EXACTLY like this inside triple backticks:

                    \`\`\`json
                    [
                    {
                        "date": "YYYY-MM-DD",
                        "sport": "Run", 
                        "description": "45-min Easy Aerobic Run",
                        "target_tss": 40,
                        "details": "Keep it conversational. Focus on hydration and maintaining good form.",
                        "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
                    }
                    ]
                    \`\`\`
                    *Note: Ensure "steps_json" is formatted as a stringified JSON array as shown in the example.*`;

                const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash", systemInstruction: systemPrompt });
                
                // Initialize the chat safely with our scrubbed history
                const chat = model.startChat({ history: cleanHistory });
                const result = await chat.sendMessage(message);
                
                let aiReply = result.response.text();
                let planUpdated = false;

                // Extract JSON if Coach Nana prescribed a workout
                const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
                if (jsonMatch) {
                    try {
                        const planData = JSON.parse(jsonMatch[1]);
                        const stmt = db.prepare(`
                            INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) 
                            VALUES (?, ?, ?, ?, ?, ?, ?) 
                            ON CONFLICT(user_id, date, sport) 
                            DO UPDATE SET description=excluded.description, target_tss=excluded.target_tss, details=excluded.details, steps_json=excluded.steps_json
                        `);
                        planData.forEach(day => {
                            stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
                        });
                        stmt.finalize();
                        planUpdated = true;
                        
                        // Strip the raw code block from the chat UI
                        aiReply = aiReply.replace(/```json[\s\S]*?```/, '').trim(); 
                    } catch(e) { console.error("Failed to parse AI JSON block", e); }
                }
                
                let mood = 'default';
                const lowerReply = aiReply.toLowerCase();
                if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
                if (lowerReply.includes('disappoint') || lowerReply.includes('skip')) mood = 'disappointed';

                db.run(`INSERT INTO chat_history (user_id, role, content) VALUES (?, 'user', ?)`, [req.user.id, message]);
                db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`, [req.user.id, aiReply, mood]);

                res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });
            });
        } catch (e) {
            console.error("Chat Server Error:", e);
            res.status(500).json({ error: "AI failed to respond." });
        }
    });
});

// --- GET CURRENT PROFILE STATUS ---
// Returns configuration states without leaking sensitive keys or passwords
app.get('/api/user/settings', authenticateToken, (req, res) => {
    db.get(
        `SELECT username, strava_refresh_token, garmin_username, coach_tone, athlete_context FROM users WHERE id = ?`, 
        [req.user.id], 
        (err, user) => {
            if (err || !user) return res.status(500).json({ error: "Failed to load settings." });
            
            res.json({
                username: user.username,
                hasStrava: !!user.strava_refresh_token,
                hasGarmin: !!user.garmin_username,
                garminUsername: user.garmin_username || '',
                coachTone: user.coach_tone,
                athleteContext: user.athlete_context
            });
        }
    );
});

// --- UPDATE COACH PERSONA SETTINGS ---
app.post('/api/user/settings/coach', authenticateToken, (req, res) => {
    const { coachTone, athleteContext } = req.body;
    
    db.run(
        `UPDATE users SET coach_tone = ?, athlete_context = ? WHERE id = ?`,
        [coachTone, athleteContext, req.user.id],
        function(err) {
            if (err) return res.status(500).json({ error: "Failed to update coach settings." });
            res.json({ message: "Coach updated successfully!" });
        }
    );
});

// --- FIX: REWRITE GARMIN ROUTE TO OVERWRITE CLEANLY ---
app.post('/api/user/settings/garmin', authenticateToken, (req, res) => {
    const { garminUsername, garminPassword } = req.body;
    
    if (!garminUsername || !garminPassword) {
        return res.status(400).json({ error: "Username and password are required." });
    }

    const encryptedPassword = encrypt(garminPassword);

    // Explicitly update both fields regardless of what was there before
    db.run(
        `UPDATE users SET garmin_username = ?, garmin_password = ? WHERE id = ?`,
        [garminUsername, encryptedPassword, req.user.id],
        function(err) {
            if (err) return res.status(500).json({ error: "Failed to save Garmin credentials." });
            res.json({ message: "Garmin connection secured successfully!" });
        }
    );
});

// --- SAVE STRAVA REFRESH TOKEN ---
app.post('/api/user/settings/strava', authenticateToken, (req, res) => {
    const { stravaRefreshToken } = req.body;
    
    if (!stravaRefreshToken) {
        return res.status(400).json({ error: "Missing Strava refresh token." });
    }

    db.run(
        `UPDATE users SET strava_refresh_token = ? WHERE id = ?`,
        [stravaRefreshToken, req.user.id],
        function(err) {
            if (err) return res.status(500).json({ error: "Failed to save Strava integration." });
            res.json({ message: "Strava connected successfully!" });
        }
    );
});

// --- MANUAL STRAVA SYNC ROUTE ---
app.post('/api/sync-strava', authenticateToken, async (req, res) => {
    db.get('SELECT strava_refresh_token FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err || !user || !user.strava_refresh_token) {
            return res.status(400).json({ error: "Strava token missing from settings." });
        }
        
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
            if (!tokenData.access_token) throw new Error("Strava rejected the token. Please check your credentials.");

            const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            
            const activities = await actRes.json();

            activities.forEach(act => {
                const tss = act.suffer_score || Math.round((act.moving_time / 3600) * 50); 
                db.run(
                    `INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [act.id, req.user.id, act.name, act.sport_type, act.distance / 1000, act.total_elevation_gain, act.moving_time / 60, act.average_heartrate || 0, act.start_date, tss]
                );
            });

            res.json({ message: `Successfully synced ${activities.length} activities!` });
        } catch (err) {
            console.error("Strava Sync Error:", err);
            res.status(500).json({ error: "Strava sync failed. Check server logs." });
        }
    });
});

// --- OAUTH: EXCHANGE STRAVA CODE FOR TOKEN ---
app.post('/api/user/settings/strava-exchange', authenticateToken, async (req, res) => {
    const { code } = req.body;

    if (!code) return res.status(400).json({ error: "No authorization code provided." });

    try {
        // Trade the temporary code for a permanent refresh token
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

        if (data.errors) {
            return res.status(400).json({ error: "Strava rejected the authorization." });
        }

        // Save the new refresh token to the logged-in user
        db.run(
            `UPDATE users SET strava_refresh_token = ? WHERE id = ?`,
            [data.refresh_token, req.user.id],
            (err) => {
                if (err) return res.status(500).json({ error: "Failed to save Strava connection." });
                res.json({ message: "Strava connected successfully!" });
            }
        );

    } catch (error) {
        res.status(500).json({ error: "Server error during Strava authentication." });
    }
});

// --- V2 DASHBOARD DATA ROUTES ---

app.get('/api/dashboard-data', authenticateToken, (req, res) => {
    // FIXED: Trims the Strava timestamp down to YYYY-MM-DD and sums daily TSS
    db.all(`SELECT substr(start_date, 1, 10) as date, SUM(tss) as daily_tss FROM activities WHERE user_id = ? GROUP BY date ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/history', authenticateToken, (req, res) => {
    db.all(`SELECT id, name, sport_type, start_date, tss FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 50`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/micro-plan', authenticateToken, (req, res) => {
    const { date, sport, description, target_tss, details } = req.body;
    db.run(
        `INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details) VALUES (?, ?, ?, ?, ?, ?) 
         ON CONFLICT(user_id, date) DO UPDATE SET sport=excluded.sport, description=excluded.description, target_tss=excluded.target_tss, details=excluded.details`,
        [req.user.id, date, sport, description, target_tss, details],
        (err) => {
            if (err) return res.status(500).json({ error: "Failed to update plan" });
            res.json({ success: true });
        }
    );
});

// --- AUTO-GENERATE WEEK ROUTE ---
app.post('/api/generate-plan', authenticateToken, async (req, res) => {
    const { targetDate } = req.body;
    
    // Notice we are now selecting the new advanced metrics
    db.get(`SELECT coach_tone, athlete_context, training_phase, current_ctl, current_atl FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Athlete context not found." });

        const systemPrompt = `You are Coach Spark, an elite Ironman Triathlon and endurance coach.
        Tone: ${user.coach_tone || 'empathetic'}
        Athlete Context: ${user.athlete_context || 'General endurance athlete'}
        
        CRITICAL RULES:
        1. You are generating a 7-day training plan starting exactly on ${targetDate}.
        2. You must append a JSON code block at the very end of your response containing the schedule.
        3. Use metric measurements exclusively (km, kg, km/h, min/km). Never use imperial units.
        4. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout, create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
        
        JSON FORMAT REQUIRED AT THE END OF YOUR RESPONSE:
        \`\`\`json
        [
          {
            "date": "YYYY-MM-DD",
            "sport": "Swim" | "Bike" | "Run" | "Rest", 
            "description": "Short title",
            "target_tss": 50,
            "details": "Workout execution details",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
          }
        ]
        \`\`\``;

        // Calculate Form (Training Stress Balance)
        // TSB = Fitness (CTL) - Fatigue (ATL)
        const ctl = user.current_ctl || 0;
        const atl = user.current_atl || 0;
        const tsb = ctl - atl;
        const phase = user.training_phase || 'Base';

        // The dynamic prompt that feeds Spark the exact physiological state
        const userPrompt = `Please generate a 7-day training plan for me starting on ${targetDate}. 
        
        Here are my current physiological metrics to govern the volume and intensity of this block:
        - Training Phase: ${phase}
        - Fitness (CTL): ${ctl}
        - Fatigue (ATL): ${atl}
        - Form (TSB): ${tsb}

        Analyze my Form (TSB). If I am highly fatigued (negative TSB), prioritize recovery. If I am fresh (positive TSB), you can push the intensity. Give me a quick encouraging summary of the week's focus based on these metrics, and then provide the JSON block.`;

       try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-3.5-flash", 
                systemInstruction: systemPrompt 
            });

            const result = await model.generateContent(userPrompt);
            let aiReply = result.response.text();
            let planUpdated = false;

            const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
            if (jsonMatch) {
                try {
                    const planData = JSON.parse(jsonMatch[1]);
                    
                    const stmt = db.prepare(`
                        INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) 
                        VALUES (?, ?, ?, ?, ?, ?, ?) 
                        ON CONFLICT(user_id, date, sport) 
                        DO UPDATE SET description=excluded.description, target_tss=excluded.target_tss, details=excluded.details, steps_json=excluded.steps_json
                    `);
                    planData.forEach(day => {
                        stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
                    });
                    stmt.finalize();
                    planUpdated = true;
                    
                    aiReply = aiReply.replace(/```json[\s\S]*?```/, '').trim(); 
                } catch(e) { console.error("Failed to parse AI JSON block", e); }
            }
            
            let mood = 'default';
            const lowerReply = aiReply.toLowerCase();
            if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
            if (lowerReply.includes('disappoint') || lowerReply.includes('skip')) mood = 'disappointed';

            // Replace with a more natural, shorter message
            const simulatedUserMessage = `Can you build my plan for next week, Spark?`;
            const coachAcknowledgement = `I've just crunched your latest numbers and pushed a fresh ${phase} phase plan to your dashboard. Go check it out—you're going to crush it!`;

            db.run(`INSERT INTO chat_history (user_id, role, content) VALUES (?, 'user', ?)`, [req.user.id, simulatedUserMessage]);
            db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`, [req.user.id, coachAcknowledgement, mood]);
            res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });

        } catch (e) {
            console.error("AI Generation Error:", e);
            res.status(500).json({ error: "AI failed to respond." });
        }
    });
});

// --- FEEDBACK UPLOAD ROUTE ---
app.post('/api/feedback', authenticateToken, upload.single('feedbackImage'), (req, res) => {
    const feedbackText = req.body.text;
    // If the user uploaded a file, multer puts it in req.file
    const imagePath = req.file ? req.file.path : null;
    const createdAt = new Date().toISOString();

    if (!feedbackText) {
        return res.status(400).json({ error: "Feedback text is required." });
    }

    db.run(
        `INSERT INTO feedback (user_id, text, image_path, created_at) VALUES (?, ?, ?, ?)`, 
        [req.user.id, feedbackText, imagePath, createdAt],
        function(err) {
            if (err) {
                console.error("Failed to save feedback:", err);
                return res.status(500).json({ error: "Failed to save feedback." });
            }
            res.json({ message: "Feedback received loud and clear! Thank you." });
        }
    );
});

// --- ADMIN FEEDBACK ROUTE ---
app.get('/api/admin/feedback', authenticateToken, (req, res) => {
    // 1. Security Check: Ensure the requester is exactly 'rutger'
    db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user || user.username.toLowerCase() !== 'rutger') {
            return res.status(403).json({ error: "Access denied. Admins only." });
        }

        // 2. Fetch feedback and join with the users table
        db.all(`
            SELECT f.id, f.text, f.image_path, f.created_at, u.username
            FROM feedback f
            LEFT JOIN users u ON f.user_id = u.id
            ORDER BY f.created_at DESC
        `, [], (err, rows) => {
            if (err) return res.status(500).json({ error: "Database error." });
            res.json(rows);
        });
    });
});

// --- MULTI-TENANT GARMIN SYNC ROUTE ---
app.post('/api/sync-garmin', authenticateToken, async (req, res) => {
    console.log("DEBUG: Sync route triggered for user:", req.user.id);
    const selectedWorkouts = req.body.workouts;

    if (!selectedWorkouts || selectedWorkouts.length === 0) {
        return res.status(400).json({ error: "No workouts selected for sync." });
    }

    try {
        // 1. Get and Decrypt credentials
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT garmin_username, garmin_password FROM users WHERE id = ?`, [req.user.id], (err, row) => {
                if (err || !row) reject(new Error("User credentials not found"));
                else resolve(row);
            });
        });

        // 2. Initialize Garmin Client
        const decryptedPassword = decrypt(user.garmin_password);
        const GCClient = new GarminConnect({ username: user.garmin_username, password: decryptedPassword });
        
        console.log("DEBUG: Attempting login for user:", user.garmin_username);
        await GCClient.login(user.garmin_username, decryptedPassword);
        const client = GCClient.client || GCClient.http;
        if (!client) throw new Error("Garmin client initialization failed.");

        // 3. Fetch workouts using a Promise (No more callback nesting)
        const todayStr = new Date().toISOString().split('T')[0];
        const workouts = await new Promise((resolve, reject) => {
            db.all(`SELECT date, sport, description, target_tss, steps_json FROM micro_plan WHERE user_id = ? AND date >= ?`, 
            [req.user.id, todayStr], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // 4. Filter and Validate
        const workoutsToSync = workouts.filter(w => 
            selectedWorkouts.some(sw => sw.date === w.date && sw.sport === w.sport)
        );

        if (workoutsToSync.length === 0) return res.status(400).json({ error: "No valid workouts found to sync." });

        let syncedCount = 0;

        // 5. Sequential Sync Loop
        for (const workout of workoutsToSync) {
            if (workout.sport === 'Rest' || !SPORT_MAP[workout.sport]) continue;

            const sportDef = SPORT_MAP[workout.sport];
            let stepsArray = [];
            try { stepsArray = JSON.parse(workout.steps_json); } catch(e) { stepsArray = []; }

            if (stepsArray.length === 0) {
                let durationMins = Math.max(5, Math.round((workout.target_tss / 55) * 60));
                stepsArray = [{ type: 'interval', condition_type: 'time', condition_value: durationMins, target_type: 'no.target' }];
            }

            const garminSteps = stepsArray.map((step, index) => {
                const normalizedType = (step.type === 'drill') ? 'interval' : step.type;
                const stepDef = STEP_TYPE_MAP[normalizedType] || STEP_TYPE_MAP['interval'];
                const targetDef = TARGET_TYPE_MAP[step.target_type] || TARGET_TYPE_MAP['no.target'];
                const conditionDef = CONDITION_TYPE_MAP[step.condition_type] || CONDITION_TYPE_MAP['time'];

                const stepDTO = {
                    type: "ExecutableStepDTO",
                    stepOrder: index + 1,
                    stepType: { stepTypeId: stepDef.id, stepTypeKey: stepDef.key },
                    endCondition: { conditionTypeId: conditionDef.id, conditionTypeKey: conditionDef.key },
                    endConditionValue: step.condition_type === 'time' ? step.condition_value * 60 : step.condition_value,
                    targetType: { workoutTargetTypeId: targetDef.id, workoutTargetTypeKey: targetDef.key },
                    targetValueOne: null, targetValueTwo: null,
                    zoneNumber: step.zone ? parseInt(step.zone, 10) : null 
                };

                if (step.condition_type === 'distance') {
                    stepDTO.preferredEndConditionUnit = { unitId: 1, unitKey: "meter", factor: 100 };
                }
                return stepDTO;
            });

            const wkt = {
                workoutName: `Coach Spark: ${workout.sport}`,
                description: workout.description,
                sportType: sportDef,
                workoutSegments: [{ segmentOrder: 1, sportType: sportDef, workoutSteps: garminSteps }]
            };

            if (workout.sport === 'Swim') {
                wkt.poolLength = 25; 
                wkt.poolLengthUnit = { unitId: 1, unitKey: "meter", factor: 100 };
            }

            try {
                const response = await client.post('https://connectapi.garmin.com/workout-service/workout', wkt);
                const workoutId = response?.workoutId || response?.data?.workoutId;
                if (workoutId) {
                    await client.post(`https://connectapi.garmin.com/workout-service/schedule/${workoutId}`, { date: workout.date });
                    syncedCount++;
                }
            } catch (err) {
                console.error(`❌ Sync Failed for ${workout.sport} on ${workout.date}:`, err.message);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        res.json({ message: `Successfully pushed ${syncedCount} structured workouts!` });

    } catch (err) {
        console.error("CRITICAL ERROR in sync-garmin:", err);
        return res.status(500).json({ error: "Server sync failed", details: err.message });
    }
});

// --- MILESTONES CALENDAR ROUTES ---
app.get('/api/milestones', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM milestones WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/milestones', authenticateToken, (req, res) => {
    const { milestones } = req.body; // Expects an array of milestone objects
    
    db.serialize(() => {
        // Wipe existing milestones for this user and rewrite to keep it clean
        db.run(`DELETE FROM milestones WHERE user_id = ?`, [req.user.id]);
        
        const stmt = db.prepare(`INSERT INTO milestones (user_id, name, date, target_ctl, is_main) VALUES (?, ?, ?, ?, ?)`);
        milestones.forEach(m => {
            stmt.run(req.user.id, m.name, m.date, m.target_ctl, m.is_main ? 1 : 0);
        });
        stmt.finalize();
        
        res.json({ success: true, message: "Calendar updated!" });
    });
});

// --- MANUALLY LOG WEIGHT ---

app.post('/api/weight', authenticateToken, (req, res) => {
    const { date, weight_kg, body_fat_percent, bmi, lean_mass_kg } = req.body;

    if (!weight_kg) return res.status(400).json({ error: "Weight is required." });

    db.run(
        `INSERT INTO biometrics (user_id, date, weight_kg, body_fat_percent, bmi, lean_mass_kg) 
         VALUES (?, ?, ?, ?, ?, ?) 
         ON CONFLICT(user_id, date) 
         DO UPDATE SET weight_kg=excluded.weight_kg, body_fat_percent=excluded.body_fat_percent, bmi=excluded.bmi, lean_mass_kg=excluded.lean_mass_kg`,
        [req.user.id, date, weight_kg, body_fat_percent || null, bmi || null, lean_mass_kg || null],
        (err) => {
            if (err) return res.status(500).json({ error: "Failed to log weight." });
            res.json({ success: true });
        }
    );
});

// --- GET USER BIOMETRICS ---
app.get('/api/weight', authenticateToken, (req, res) => {
    db.all(
        `SELECT date, weight_kg, body_fat_percent, bmi, lean_mass_kg 
         FROM biometrics 
         WHERE user_id = ? 
         ORDER BY date ASC`, 
        [req.user.id], 
        (err, rows) => {
            if (err) {
                console.error("Database error fetching weight:", err);
                return res.status(500).json({ error: "Failed to fetch weight data." });
            }
            res.json(rows || []);
        }
    );
});

async function getStravaActivity(userId, activityId) {
    try {
        // 1. Get token for THIS specific user
        const token = await getStravaTokenForUser(userId); // You'll need this helper
        
        // Fetch activity
        const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, { 
            headers: { 'Authorization': `Bearer ${token}` } 
        });
        const data = await res.json();
        
        // Calculate TSS
        const tss = Math.round((data.moving_time / 3600) * Math.pow((data.average_heartrate || 165) / 165, 2) * 100);
        
        // 2. Save/Update activity for this specific user
        db.run(`INSERT INTO activities (user_id, id, name, sport_type, tss, start_date) 
                VALUES (?, ?, ?, ?, ?, ?) 
                ON CONFLICT(id) DO UPDATE SET tss=excluded.tss`,
            [userId, data.id, data.name, data.sport_type, tss, data.start_date]);

        const activityDate = data.start_date.split('T')[0];
        
        // 3. Fetch plan for THIS user on THAT date
        db.get("SELECT description, target_tss, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ?", 
            [userId, activityDate], async (err, plan) => {
            
            if (err || !plan) return; 

            // ... (Keep your existing newDescription formatting logic here) ...
            
            // 4. Update Strava
            await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
                method: 'PUT',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ description: newDescription })
            });
        });

    } catch (e) { 
        console.error(`Activity Fetch/Update Error for User ${userId}:`, e); 
    }
}

// --- ADMIN FEEDBACK LOGIC ---
async function loadAdminFeedback() {
    try {
        const response = await fetch('/api/admin/feedback', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });

        // If the server rejects us (403), do nothing
        if (!response.ok) return; 

        const data = await response.json();
        const tbody = document.getElementById('admin-feedback-table');
        
        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-8 text-center text-theme-muted">No feedback yet. You're doing great!</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(f => {
            // Format the date nicely
            const date = new Date(f.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            
            // Format the image link if an image exists
            let imageHtml = '<span class="text-theme-muted text-[10px]">None</span>';
            if (f.image_path) {
                // We use replace to ensure Windows backslashes are converted to web forward-slashes just in case
                const imgUrl = `/${f.image_path.replace(/\\/g, '/')}`; 
                // We reuse your enlargeAvatar function to make it pop up beautifully!
                imageHtml = `<button onclick="enlargeAvatar('${imgUrl}')" class="text-theme-accent hover:underline text-xs font-bold transition">🖼️ View</button>`;
            }

            return `
                <tr class="hover:bg-theme-bg transition">
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

app.listen(process.env.PORT || 3001, () => {
    console.log('🚀 Coach Nana HQ Multi-Tenant Engine live on port 3001...');
});