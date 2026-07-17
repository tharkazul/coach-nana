require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { GarminConnect } = require('@flow-js/garmin-connect');
const fuzzysort = require('fuzzysort');
const fs = require('fs');

let garminExercises = [];
try {
    garminExercises = JSON.parse(fs.readFileSync('./garmin_exercises.json', 'utf8'));
    console.log(`Loaded ${garminExercises.length} Garmin exercises for fuzzy matching.`);
} catch (e) {
    console.error("Could not load garmin_exercises.json:", e);
}

function matchGarminExercise(name) {
    if (!name || garminExercises.length === 0) return null;
    const results = fuzzysort.go(name, garminExercises, { key: 'exercise_name', limit: 1 });
    if (results && results.length > 0) {
        // Only return if it's a reasonably good match
        if (results[0].score > 0.4) {
            return results[0].obj;
        }
    }
    return null;
}

const multer = require('multer');
const path = require('path');

// --- GEMINI LOAD BALANCER REGISTRY ---
const geminiConfigs = [
    {
        name: "Primary",
        model: "gemini-3.5-flash",
        apiKey: process.env.GEMINI_API_KEY // Your main key
    },
    {
        name: "Backup",
        model: "gemini-2.5-flash",
        apiKey: process.env.GEMINI_API_KEY_BACKUP || process.env.GEMINI_API_KEY // Uses backup key if it exists, otherwise re-uses the main one
    },
    {
        name: "Tertiary",
        model: "gemini-3.1-flash-lite",
        apiKey: process.env.GEMINI_API_KEY_TERTIARY || process.env.GEMINI_API_KEY_BACKUP || process.env.GEMINI_API_KEY
    }
];

function getAMSDateString(date = new Date()) {
    return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

function getAMSWeekday(date = new Date()) {
    return new Date(date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Europe/Amsterdam' });
}

const app = express();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
const IV_LENGTH = 16; // For AES, this is always 16 bytes

app.use(bodyParser.json({ limit: '15mb' }));
app.use(express.static('public'));

const physiqueStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'secure_uploads/physique');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `physique_${req.user.id}_${crypto.randomUUID()}${ext}`);
    }
});
const uploadPhysique = multer({ storage: physiqueStorage });

const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/uploads/profiles');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
    }
});
const uploadProfile = multer({ storage: profileStorage });

// Image Cleanup Routine (Every Hour)
setInterval(() => {
    const dir = path.join(__dirname, 'secure_uploads/chat_images');
    if (fs.existsSync(dir)) {
        fs.readdir(dir, (err, files) => {
            if (err) return console.error('Cleanup Error:', err);
            const now = Date.now();
            files.forEach(file => {
                const filePath = path.join(dir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) return;
                    if (now - stats.mtimeMs > 86400000) { // 24 hours
                        fs.unlink(filePath, err => {
                            if (!err) console.log(`Auto-cleaned old image: ${file}`);
                        });
                    }
                });
            });
        });
    }
}, 3600000);

function getUserLeaderboardString(userId) {
    return new Promise((resolve) => {
        db.all(`
            SELECT u.username, SUM(a.spark_score) as total_spark_score
            FROM activities a
            JOIN users u ON a.user_id = u.id
            WHERE (a.user_id = ? OR a.user_id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
              AND a.start_date >= datetime('now', '-7 days')
            GROUP BY u.id
            ORDER BY total_spark_score DESC
        `, [userId, userId], (err, rows) => {
            if (err || !rows || rows.length === 0) return resolve('');
            const lb = rows.map((r, i) => `${i + 1}. ${r.username} (${Math.round(r.total_spark_score)} Points)`).join(', ');
            resolve(`\n\nCurrent Leaderboard: ${lb}`);
        });
    });
}

// AI Proactive 24h Check-in Routine (Every Hour)
setInterval(() => {
    console.log("🕒 Running 24h inactivity check...");
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    db.all(`
        SELECT u.id, u.email, u.coach_tone 
        FROM users u
        WHERE NOT EXISTS (
            SELECT 1 FROM chat_history ch 
            WHERE ch.user_id = u.id 
            AND ch.timestamp > ?
        )
    `, [twentyFourHoursAgo], async (err, inactiveUsers) => {
        if (err || !inactiveUsers) return;

        for (const user of inactiveUsers) {
            console.log(`🤖 User ${user.id} inactive for 24h. Generating proactive message...`);
            const lbString = await getUserLeaderboardString(user.id);
            const prompt = `The user has not logged any activities or sent any messages in over 24 hours. Write a short, proactive message checking in on them and asking how their training is going. Use the tone: ${user.coach_tone || 'Friendly and motivating'}. Keep it under 2 sentences. If applicable, playfully use their standing on the leaderboard to motivate them: ${lbString}`;

            try {
                const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${user.coach_tone || 'Friendly and motivating'}. Act like a real human in a continuous text message thread.`;
                const aiReply = await generateWithFallback(prompt, systemPrompt);
                db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'curious')`, [user.id, aiReply]);
                sendSSEEvent(user.id, 'unread_message', { message: aiReply, mood: 'curious' });
            } catch (e) {
                console.error("Proactive AI generation failed:", e);
            }
        }
    });
}, 3600000);

// Endpoint to manually simulate the 24h inactivity trigger
app.post('/api/admin/simulate-24h', authenticateToken, async (req, res) => {
    const user = req.user;
    console.log(`🤖 Simulating 24h inactivity for user ${user.id}...`);

    db.get(`SELECT coach_tone FROM users WHERE id = ?`, [user.id], async (err, row) => {
        const lbString = await getUserLeaderboardString(user.id);
        const prompt = `The user has not logged any activities or sent any messages in over 24 hours. Write a short, proactive message checking in on them and asking how their training is going. Use the tone: ${row ? row.coach_tone : 'Friendly and motivating'}. Keep it under 2 sentences. If applicable, playfully use their standing on the leaderboard to motivate them: ${lbString}`;
        try {
            const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${row ? row.coach_tone : 'Friendly and motivating'}. Act like a real human in a continuous text message thread.`;
            const aiReply = await generateWithFallback(prompt, systemPrompt);
            db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'curious')`, [user.id, aiReply]);
            sendSSEEvent(user.id, 'unread_message', { message: aiReply, mood: 'curious' });
            res.json({ success: true, message: "Trigger fired." });
        } catch (e) {
            console.error("Simulated AI generation failed:", e);
            res.status(500).json({ error: "Failed" });
        }
    });
});

async function generateWithFallback(prompt, systemInstruction = null, chatHistory = null, imageBase64 = null, userId = null) {
    let lastError = null;

    for (let i = 0; i < geminiConfigs.length; i++) {
        const config = geminiConfigs[i];

        try {
            console.log(`🤖 Attempting AI generation with ${config.name} (${config.model})...`);

            const genAI = new GoogleGenerativeAI(config.apiKey);

            // Build model options
            const modelOptions = { model: config.model };
            if (systemInstruction) {
                modelOptions.systemInstruction = systemInstruction;
            }

            const model = genAI.getGenerativeModel(modelOptions);

            let result;

            let promptContent = prompt;
            if (imageBase64) {
                promptContent = [
                    { text: prompt },
                    { inlineData: { data: imageBase64, mimeType: "image/jpeg" } }
                ];
            }

            if (chatHistory) {
                // If history is provided, use the Chat interface
                const chat = model.startChat({ history: chatHistory });
                result = await chat.sendMessage(promptContent);
            } else {
                // Otherwise, use a standard single-shot prompt
                result = await model.generateContent(promptContent);
            }

            // Log Token Usage to terminal for monitoring
            const usage = result.response.usageMetadata;
            if (usage) {
                console.log(`🪙 Tokens Used -> Input: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount} | Total: ${usage.totalTokenCount}`);
                if (userId) {
                    db.run(`UPDATE users SET daily_token_usage = daily_token_usage + ? WHERE id = ?`, [usage.totalTokenCount, userId]);
                }
            }

            console.log(`✅ AI Success using ${config.name}!`);
            return result.response.text();

        } catch (error) {
            console.warn(`⚠️ ${config.name} failed. Reason: ${error.message}`);
            lastError = error;
            // The loop continues to the next config automatically
        }
    }

    console.error("❌ CRITICAL: All Gemini fallback models failed.");
    throw new Error("Spark is currently catching their breath. Please try again in a moment.");
}

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

// --- DATABASE INITIALIZATION ---
const dbPath = process.env.DB_PATH || './nana_multi.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password_hash TEXT, 
        strava_refresh_token TEXT, 
        garmin_username TEXT, 
        garmin_password TEXT, 
        coach_tone TEXT DEFAULT 'Empathetic but demanding elite endurance coach.', 
        athlete_context TEXT DEFAULT 'No context provided yet.',
        long_term_memory TEXT DEFAULT '',
        daily_token_usage INTEGER DEFAULT 0,
        last_token_reset_date TEXT,
        search_privacy INTEGER DEFAULT 0,
        profile_picture_url TEXT
    )`);
    // Add columns if they don't exist (fails silently if they do)
    db.run(`ALTER TABLE users ADD COLUMN long_term_memory TEXT DEFAULT ''`, (err) => { });
    db.run(`ALTER TABLE users ADD COLUMN daily_token_usage INTEGER DEFAULT 0`, (err) => { });
    db.run(`ALTER TABLE users ADD COLUMN last_token_reset_date TEXT`, (err) => { });
    db.run(`ALTER TABLE users ADD COLUMN search_privacy INTEGER DEFAULT 0`, (err) => { });
    db.run(`ALTER TABLE users ADD COLUMN profile_picture_url TEXT`, (err) => { });
    db.run(`CREATE TABLE IF NOT EXISTS strava_tokens (
        user_id INTEGER PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        strava_id TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, sport_type TEXT, distance_km REAL, elevation_m INTEGER, moving_time_min REAL, average_heartrate REAL, start_date TEXT, tss REAL)`);
    db.run(`ALTER TABLE activities ADD COLUMN spark_score REAL`, (err) => {
        // Automatically backfill any activities that have a NULL spark_score
        db.all(`SELECT id, moving_time_min, average_heartrate FROM activities WHERE spark_score IS NULL`, (err, rows) => {
            if (!err && rows && rows.length > 0) {
                console.log(`Backfilling spark_score for ${rows.length} activities...`);
                const stmt = db.prepare(`UPDATE activities SET spark_score = ? WHERE id = ?`);
                rows.forEach(row => {
                    let bonus = 0;
                    if (row.average_heartrate) {
                        if (row.average_heartrate >= 180) bonus = 0.40;
                        else if (row.average_heartrate >= 160) bonus = 0.30;
                        else if (row.average_heartrate >= 140) bonus = 0.20;
                        else if (row.average_heartrate >= 120) bonus = 0.10;
                    }
                    const score = (row.moving_time_min || 0) + ((row.moving_time_min || 0) * bonus);
                    stmt.run(score, row.id);
                });
                stmt.finalize(() => console.log("Spark Score backfill complete."));
            }
        });
    });
    db.run(`ALTER TABLE activities ADD COLUMN sets_json TEXT`, (err) => {
        if (!err) console.log("Added sets_json column to activities table.");
    });
    db.run(`CREATE TABLE IF NOT EXISTS micro_plan (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_spark REAL, details TEXT, steps_json TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
    db.run(`ALTER TABLE micro_plan RENAME COLUMN target_tss TO target_spark`, (err) => { });

    // Ensure steps_json exists for legacy DBs (if table has id but no steps_json)
    db.run(`ALTER TABLE micro_plan ADD COLUMN steps_json TEXT DEFAULT '[]'`, (err) => {
        if (err && !err.message.includes("duplicate column name")) {
            console.error("Error adding steps_json column:", err.message);
        }
    });

    // Migration: check if micro_plan is missing the 'id' column. If so, rebuild it.
    // This also implicitly drops the legacy UNIQUE(user_id, date, sport) constraint so users can have 2 runs in a day.
    db.all(`PRAGMA table_info(micro_plan);`, (err, rows) => {
        if (!err && rows && rows.length > 0) {
            const hasId = rows.some(r => r.name === 'id');
            if (!hasId) {
                console.log("Migrating micro_plan table to include id column and drop unique constraints...");
                db.serialize(() => {
                    db.run(`CREATE TABLE IF NOT EXISTS micro_plan_new (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_spark REAL, details TEXT, steps_json TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
                    db.run(`INSERT INTO micro_plan_new (user_id, date, sport, description, target_spark, details, steps_json) SELECT user_id, date, sport, description, target_tss as target_spark, details, steps_json FROM micro_plan`);
                    db.run(`DROP TABLE micro_plan`);
                    db.run(`ALTER TABLE micro_plan_new RENAME TO micro_plan`);
                });
            }
        }
    });

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
    db.run(`CREATE TABLE IF NOT EXISTS physique_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        weight_kg REAL,
        sleep_quality INTEGER,
        fatigue_level INTEGER,
        notes TEXT,
        photo_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
    db.run(`CREATE TABLE IF NOT EXISTS nutrition_protocols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        protocol_json TEXT,
        UNIQUE(user_id, date)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS connections (
        user_id INTEGER,
        friend_id INTEGER,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, friend_id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(friend_id) REFERENCES users(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS kudos (
        activity_id INTEGER,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(activity_id, user_id),
        FOREIGN KEY(activity_id) REFERENCES activities(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS public_profile_cache (
        user_id INTEGER PRIMARY KEY,
        data TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- AUTHENTICATION MIDDLEWARE ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    if (!token && req.query.token) token = req.query.token;

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
    'Swim': { sportTypeId: 4, sportTypeKey: "swimming" },
    'Strength': { sportTypeId: 5, sportTypeKey: "strength_training" }
};

const STEP_TYPE_MAP = {
    'warmup': { id: 1, key: "warmup" },
    'cooldown': { id: 2, key: "cooldown" },
    'interval': { id: 3, key: "interval" },
    'recovery': { id: 4, key: "recovery" },
    'rest': { id: 5, key: "rest" }
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
    'time_sec': { id: 2, key: "time" },
    'distance': { id: 3, key: "distance" },
    'lap.button': { id: 1, key: "lap.button" },
    'reps': { id: 10, key: "reps" }
};

// --- SERVER-SENT EVENTS (SSE) FOR REAL-TIME UPDATES ---
const sseClients = new Map(); // Maps userId -> Set of response objects

function sendSSEEvent(userId, eventName, data) {
    const clients = sseClients.get(userId);
    if (clients) {
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        clients.forEach(client => {
            try {
                client.write(payload);
            } catch (err) {
                clients.delete(client);
            }
        });
    }
}

app.get('/api/events', authenticateToken, (req, res) => {
    const userId = req.user.id;

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Cloudflare buffering if applicable

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

    // Store the client
    if (!sseClients.has(userId)) {
        sseClients.set(userId, new Set());
    }
    const clients = sseClients.get(userId);
    clients.add(res);

    // Send a heartbeat ping every 30 seconds to keep connection alive (prevents Cloudflare QUIC timeout)
    const heartbeat = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch (err) {
            clearInterval(heartbeat);
        }
    }, 30000);

    // Remove client when connection closes
    req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (clients.size === 0) {
            sseClients.delete(userId);
        }
    });
});

// --- STRAVA WEBHOOK VERIFICATION (HANDSHAKE) ---
app.get('/webhook/strava', (req, res) => {
    const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || "STRAVA";

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Strava Webhook Verified!');
            res.json({ "hub.challenge": challenge });
        } else {
            res.sendStatus(403);
        }
    }
});

// --- EXISTING POST ROUTE ---
app.post('/webhook/strava', (req, res) => {
    console.log("📥 STRAVA WEBHOOK INCOMING PAYLOAD:", JSON.stringify(req.body, null, 2));
    const { aspect_type, object_id, owner_id, object_type } = req.body;

    if (aspect_type === 'create' && object_type === 'activity') {
        console.log(`🏃‍♂️ New Strava activity detected! Fetching ID: ${object_id}`);
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
            function (err) {
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
            const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
            db.run(`UPDATE users SET login_count = login_count + 1 WHERE id = ?`, [user.id]);
            res.json({ token, message: "Welcome to Spark HQ" });
        } else {
            res.status(401).json({ error: "Incorrect password." });
        }
    });
});

app.get('/api/micro-plan', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM micro_plan WHERE user_id = ? ORDER BY date ASC`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/chat/history', authenticateToken, (req, res) => {
    db.all(`SELECT role, content, mood, timestamp, image_path FROM chat_history WHERE user_id = ? ORDER BY id ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load chat history." });
        res.json(rows || []);
    });
});

async function getUserMacroPhase(userId) {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM milestones WHERE user_id = ? AND is_main = 1 ORDER BY date ASC`, [userId], (err, rows) => {
            let phase = "BASE";
            if (!err && rows && rows.length > 0) {
                const today = new Date();
                let nextRace = rows.find(m => new Date(m.date) >= today);
                if (nextRace) {
                    let daysUntil = Math.floor((new Date(nextRace.date) - today) / (1000 * 60 * 60 * 24));
                    if (daysUntil <= 14) phase = "TAPER";
                    else if (daysUntil <= 56) phase = "PEAK";
                    else if (daysUntil <= 112) phase = "BUILD";
                }
            }
            resolve(phase);
        });
    });
}

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message, imageBase64 } = req.body;
    db.run(`UPDATE users SET chat_count = chat_count + 1 WHERE id = ?`, [req.user.id]);

    let imagePathDB = null;
    let base64Data = null;

    if (imageBase64) {
        try {
            // imageBase64 is expected to look like "data:image/jpeg;base64,/9j/4AAQSk..."
            const matches = imageBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const ext = matches[1];
                base64Data = matches[2];
                const fileName = `img_${req.user.id}_${crypto.randomUUID()}.${ext}`;
                const dir = path.join(__dirname, 'secure_uploads/chat_images');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const savePath = path.join(dir, fileName);
                fs.writeFileSync(savePath, base64Data, 'base64');
                imagePathDB = `/api/images/chat/${fileName}`;
            }
        } catch (e) {
            console.error("Image saving error:", e);
        }
    }

    db.get(`SELECT coach_tone, athlete_context, long_term_memory, daily_token_usage, last_token_reset_date FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err) {
            console.error("DB Error fetching user context:", err);
            return res.status(500).json({ error: "Failed to load athlete context." });
        }
        if (!user) {
            return res.status(500).json({ error: "Athlete context not found." });
        }

        // Token limit logic
        const todayStr = new Date().toISOString().split('T')[0];
        let currentDailyUsage = user.daily_token_usage || 0;

        if (user.last_token_reset_date !== todayStr) {
            currentDailyUsage = 0;
            db.run(`UPDATE users SET daily_token_usage = 0, last_token_reset_date = ? WHERE id = ?`, [todayStr, req.user.id]);
        }

        if (currentDailyUsage > 100000) {
            return res.status(429).json({ error: "Daily token limit reached. Please try again tomorrow!" });
        }

        db.all(`SELECT metric, value FROM athlete_metrics WHERE user_id = ?`, [req.user.id], async (err, metricsRows) => {
            const metricsText = (metricsRows && metricsRows.length > 0)
                ? metricsRows.map(m => `${m.metric}: ${m.value}`).join(', ')
                : 'None explicitly recorded yet.';

            const phase = await getUserMacroPhase(req.user.id);
            try {
                db.all(`SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`, [req.user.id], async (err, recentActivities) => {
                    const recentActivitiesText = (recentActivities && recentActivities.length > 0)
                        ? recentActivities.map(a => `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${Math.round(a.spark_score || 0)} Spark`).join('\n                    ')
                        : 'No recent activities recorded.';

                    db.all(`SELECT sport_type, start_date, sets_json FROM activities WHERE user_id = ? AND sets_json IS NOT NULL AND sets_json != '[]' ORDER BY start_date DESC LIMIT 5`, [req.user.id], async (err, recentSetsRows) => {
                        let recentSetsText = "No recent strength/PB data recorded.";
                        if (recentSetsRows && recentSetsRows.length > 0) {
                            recentSetsText = recentSetsRows.map(row => `Date: ${row.start_date}, Sport: ${row.sport_type}, Details: ${row.sets_json}`).join('\n');
                        }

                        db.all(`SELECT * FROM micro_plan WHERE user_id = ? AND date >= date('now', 'localtime') ORDER BY date ASC LIMIT 14`, [req.user.id], async (err, planRows) => {
                            const planText = (planRows && planRows.length > 0)
                                ? planRows.map(p => `- ${p.date}: ${p.sport} - ${p.description} (${p.target_spark || p.target_tss || 0} Spark)`).join('\n                    ')
                                : 'No upcoming workouts scheduled.';

                            db.all(`SELECT name, date, target_ctl FROM milestones WHERE user_id = ? AND date >= date('now', 'localtime') ORDER BY date ASC LIMIT 3`, [req.user.id], async (err, milestoneRows) => {
                                const milestonesText = (milestoneRows && milestoneRows.length > 0)
                                    ? milestoneRows.map(m => `- ${m.date}: ${m.name} (Target CTL: ${m.target_ctl})`).join('\n                    ')
                                    : 'No upcoming events/milestones.';

                                db.all(`SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 6) ORDER BY id ASC`, [req.user.id], async (err, historyRows) => {
                            try {
                                let cleanHistory = [];

                                (historyRows || []).forEach(row => {
                                    let currentRole = row.role === 'coach' ? 'model' : 'user';

                                    if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === currentRole) {
                                        cleanHistory[cleanHistory.length - 1].parts[0].text += "\n\n" + row.content;
                                    } else {
                                        cleanHistory.push({
                                            role: currentRole,
                                            parts: [{ text: row.content }]
                                        });
                                    }
                                });

                                if (cleanHistory.length > 0 && cleanHistory[0].role !== 'user') {
                                    cleanHistory.shift();
                                }
                                if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'user') {
                                    cleanHistory.pop();
                                }

                                const todayStr = getAMSDateString();
                                const next7Days = Array.from({ length: 7 }, (_, i) => {
                                    const d = new Date();
                                    d.setDate(d.getDate() + i);
                                    return `${getAMSWeekday(d)}: ${getAMSDateString(d)}`;
                                }).join(', ');

                                const systemPrompt = `You are a real, highly experienced endurance coach sending text messages to an athlete.
                    Name: Spark
                    Tone: ${user.coach_tone}
                    Current Training Phase: ${phase || user.training_phase || 'Base/General'}
                    
                    TIME CONTEXT:
                    Today is ${todayStr}.
                    The upcoming week mapping is:
                    ${next7Days}
                    
                    ATHLETE CONTEXT:
                    ${user.athlete_context}
                    
                    LONG-TERM MEMORY (From Past Conversations):
                    ${user.long_term_memory}

                    PHYSIOLOGICAL METRICS:
                    ${metricsText}
                    
                    UPCOMING EVENTS/MILESTONES:
                    ${milestonesText}

                    UPCOMING SCHEDULED WORKOUTS (Microplan):
                    ${planText}
                    
                    RECENT COMPLETED WORKOUTS (For context):
                    ${recentActivitiesText}

                    RECENT STRENGTH & PB HISTORY:
                    ${recentSetsText}

                    PHASE GUIDANCE:
                    - If phase is BASE: Focus on aerobic volume and consistency. Discourage racing or excessive intensity.
                    - If phase is BUILD: Focus on progressing their threshold and VO2max intervals. Tell them it's time to push.
                    - If phase is PEAK: Focus on race-specific intensity and sharpening. Keep them focused on executing race pace perfectly.
                    - If phase is TAPER: Focus heavily on recovery and shedding fatigue. Ensure they rest up for the race.

                    CRITICAL RULES:
                    1. Act like a real human in a continuous text message thread: keep your responses concise, focused, and natural.
                    2. NEVER repeat your previous greetings, praises, or paragraphs verbatim. Do not bring up old topics unless the athlete explicitly mentions them.
                    3. Always use metric measurements exclusively (meters for distance, km/h for speed, min/km for pace). Never use imperial units.
                    4. Respond directly with your conversational text. Do not wrap your main reply in JSON.
                    5. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout (e.g., Bike + Run), you MUST create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
                    6. INTERVALS: To create a repeating block (e.g., 8x 3min fast, 1min rest), use a "repeat" object in steps_json with "iterations" and an array of "steps".
                    7. SENTIMENT & SUPPORT: Pay close attention to the athlete's physical and mental state. If they mention soreness, exhaustion, poor sleep, or lack of motivation, immediately prioritize empathy and recovery. Strongly advise them to rest or dial back intensity, even if it means modifying the plan.
                    8. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Use simple, standard exercise names (e.g., "Barbell Back Squat", "Dumbbell Lunge"). Between sets, use a "rest" step with "condition_type": "time_sec" and set "condition_value" to the number of SECONDS to rest (e.g., 90 for 90 seconds). Reference the Athlete Context for their past weights, and try to prescribe slight progressive overload (e.g., +2.5kg).
                    9. TARGETS: If a workout requires a specific pace (e.g. "4:15 min/km") or power (e.g. "250W") instead of a generic zone, add a "target_value" string to the step object (e.g., "target_value": "4:15 min/km"). Otherwise, continue using "zone": <number>.

                    WORKOUT PLANNING (CRITICAL):
                    If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
                    The JSON must be a valid Array of objects. Format it EXACTLY like this inside triple backticks:
                    \`\`\`json
                    [
                      {
                        "date": "YYYY-MM-DD",
                        "sport": "Run", 
                        "description": "5k Speed Intervals",
                        "target_spark": 80,
                        "details": "Push hard on the intervals, recover fully on the rests.",
                        "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"rest\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
                      }
                    ]
                    \`\`\`
                    *Note: Ensure "steps_json" is formatted as a stringified JSON array as shown in the examples. Exercises MUST go in steps_json, NOT details!*
                    
                    IMAGE GENERATION (NEW):
                    If the athlete asks for an illustration, visualization, diagram, or picture of an exercise, route, pose, or anything else, you can seamlessly generate an image by outputting a Markdown image tag with the following URL format:
                    \`![Description of Image](https://image.pollinations.ai/prompt/{URL_ENCODED_PROMPT}?nologo=true)\`
                    Replace {URL_ENCODED_PROMPT} with a highly detailed, descriptive prompt for an image generation model. Always include '?nologo=true'. The app will automatically render this image!

                    ATHLETE METRICS MEMORY (CRITICAL):
                    If the athlete mentions a new personal best, physiological metric, or baseline number (e.g., FTP, 5K pace, Max HR, resting heart rate, swim threshold), you MUST output an additional JSON block at the very end of your response to commit it to your long-term memory. Format it exactly like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "metrics",
                      "data": {
                        "FTP": "285W",
                        "5K Pace": "4:05 min/km"
                      }
                    }
                    \`\`\`
                    
                    MANUAL ACTIVITY LOGGING:
                    If the athlete manually tells you they completed a workout that hasn't synced from Strava (e.g. they say "I just ran 5k in 25 mins" or "Did a 45 min gym session"), you MUST log it by outputting an additional JSON block at the very end of your response. Format it exactly like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "log_activity",
                      "data": {
                        "name": "Gym Workout",
                        "sport_type": "Strength",
                        "distance_km": 0,
                        "moving_time_min": 30,
                        "spark_score": 25
                      }
                    }
                    \`\`\``;

                                let aiReply = await generateWithFallback(message, systemPrompt, cleanHistory, base64Data, req.user.id);
                                let planUpdated = false;

                                const jsonMatches = [...aiReply.matchAll(/```json\n?([\s\S]*?)```/gi)];
                                for (const match of jsonMatches) {
                                    try {
                                        const parsedData = JSON.parse(match[1]);

                                        if (Array.isArray(parsedData)) {
                                            const planData = parsedData;
                                            const affectedDates = [...new Set(planData.map(day => day.date))];

                                            if (affectedDates.length > 0) {
                                                const placeholders = affectedDates.map(() => '?').join(',');

                                                db.run(`DELETE FROM micro_plan WHERE user_id = ? AND date IN (${placeholders})`, [req.user.id, ...affectedDates], (err) => {
                                                    if (err) console.error("Failed to clear old plan data:", err);

                                                    const stmt = db.prepare(`
                                        INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) 
                                        VALUES (?, ?, ?, ?, ?, ?, ?)
                                    `);

                                                    planData.forEach(day => {
                                                        stmt.run(req.user.id, day.date, day.sport, day.description, day.target_spark, day.details, day.steps_json || '[]');
                                                    });
                                                    stmt.finalize();
                                                });
                                            }
                                            planUpdated = true;
                                        } else if (parsedData && parsedData.type === 'metrics' && parsedData.data) {
                                            const stmt = db.prepare(`INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, ?, ?) ON CONFLICT(user_id, metric) DO UPDATE SET value=excluded.value`);
                                            for (const [key, val] of Object.entries(parsedData.data)) {
                                                stmt.run(req.user.id, key, String(val));
                                            }
                                            stmt.finalize();
                                        } else if (parsedData && parsedData.type === 'log_activity' && parsedData.data) {
                                            const act = parsedData.data;
                                            // Use negative ID to avoid collision with real Strava IDs
                                            const manualId = -Date.now();
                                            const startDate = new Date().toISOString();

                                            db.run(
                                                `INSERT INTO activities (id, user_id, name, sport_type, distance_km, moving_time_min, start_date, spark_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                                [manualId, req.user.id, act.name || 'Manual Workout', act.sport_type || 'Workout', act.distance_km || 0, act.moving_time_min || 0, startDate, act.spark_score || 0],
                                                (err) => {
                                                    if (err) console.error("Failed to insert manual activity:", err);
                                                    else {
                                                        // Invalidate today's nutrition cache so it incorporates the new workout
                                                        const todayStr = startDate.split('T')[0];
                                                        db.run(`DELETE FROM nutrition_protocols WHERE user_id = ? AND date = ?`, [req.user.id, todayStr]);
                                                    }
                                                }
                                            );
                                            planUpdated = true; // Signal frontend to reload data/charts
                                        }
                                    } catch (e) {
                                        console.error("Failed to parse an AI JSON block", e);
                                    }
                                }

                                aiReply = aiReply.replace(/```json[\s\S]*?```/gi, '').trim();

                                let mood = 'default';
                                const lowerReply = aiReply.toLowerCase();

                                // if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
                                // if (lowerReply.includes('disappoint') || lowerReply.includes('skip')) mood = 'disappointed';

                                // Define your keyword arrays here
                                const hypeKeywords = ['crush', '!', 'epic', 'beast', 'machine', 'proud', 'smash', 'nailed', 'unstoppable', 'fire', 'stellar'];
                                const disappointedKeywords = ['disappoint', 'skip', 'excuse', 'slack', 'shortcut', 'off track', 'slipping', 'warning'];
                                const hornyKeywords = ['horny', 'sexy', 'flirt', 'desire', 'attractive', 'love', 'passion', 'lust', 'dream', 'hot'];
                                // .some() acts as a giant OR statement across the whole array
                                if (hypeKeywords.some(word => lowerReply.includes(word))) {
                                    mood = 'hype';
                                } else if (hornyKeywords.some(word => lowerReply.includes(word))) {
                                    mood = 'horny';
                                } else if (disappointedKeywords.some(word => lowerReply.includes(word))) {
                                    mood = 'disappointed';
                                }


                                const simulatedUserMessage = `Can you build my plan for next week, Spark?`;
                                const coachAcknowledgement = `I've just crunched your latest numbers and pushed a fresh ${phase} phase plan to your dashboard. Go check it out—you're going to crush it!`;

                                db.run(`INSERT INTO chat_history (user_id, role, content, image_path) VALUES (?, 'user', ?, ?)`, [req.user.id, message, imagePathDB]);
                                db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`, [req.user.id, aiReply, mood]);

                                db.get(`SELECT COUNT(*) as count FROM chat_history WHERE user_id = ?`, [req.user.id], (err, row) => {
                                    if (row && row.count > 0 && row.count % 6 === 0) {
                                        triggerBackgroundSummary(req.user.id);
                                    }
                                });

                                res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });
                            } catch (innerErr) {
                                console.error("Async Error in chat history callback:", innerErr);
                                if (!res.headersSent) {
                                    res.status(500).json({ error: "Internal chat processing error" });
                                }
                            }
                        });
                    });
                    });
                    });
                });
            } catch (e) {
                console.error("Chat Server Error:", e);
                res.status(500).json({ error: "AI failed to respond." });
            }
        });
    });
});

app.get('/api/chat/briefing', authenticateToken, (req, res) => {
    db.get(`SELECT content, mood, timestamp FROM chat_history 
            WHERE user_id = ? AND role = 'coach' AND date(timestamp, 'localtime') = date('now', 'localtime') 
            ORDER BY timestamp ASC LIMIT 1`,
        [req.user.id], (err, row) => {
            if (err) {
                console.error("Error fetching briefing:", err);
                return res.status(500).json({ error: "Failed to fetch briefing." });
            }
            res.json({ briefing: row || null });
        });
});

app.post('/api/chat/checkin', authenticateToken, async (req, res) => {
    db.get(`SELECT coach_tone, athlete_context FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Failed to load athlete context." });

        db.all(`SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`, [req.user.id], async (err, recentActivities) => {
            const recentActivitiesText = (recentActivities && recentActivities.length > 0)
                ? recentActivities.map(a => `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${Math.round(a.spark_score || 0)} Spark`).join('\n')
                : 'No recent activities recorded.';


            db.all(`SELECT metric, value FROM athlete_metrics WHERE user_id = ?`, [req.user.id], async (err, metrics) => {
                const metricsText = (metrics && metrics.length > 0)
                    ? metrics.map(m => `${m.metric}: ${m.value}`).join(', ')
                    : 'No metrics recorded.';

                db.all(`SELECT date, sport, description FROM micro_plan WHERE user_id = ? AND date >= date('now') ORDER BY date ASC LIMIT 2`, [req.user.id], async (err, upcomingPlan) => {
                    const upcomingText = (upcomingPlan && upcomingPlan.length > 0)
                        ? upcomingPlan.map(p => `- ${p.date}: ${p.sport} - ${p.description}`).join('\n')
                        : 'No upcoming workouts scheduled.';

                    const phase = await getUserMacroPhase(req.user.id);
                    const todayStr = getAMSDateString();
                    let systemPrompt = `You are Spark, an elite Ironman Triathlon and endurance coach.
Today is ${todayStr}.
Athlete Context: ${user.athlete_context || 'General endurance athlete'}
Key Physiological Metrics:
${metricsText}
Current Macro Phase: ${phase}
Recent Completed Workouts:
${recentActivitiesText}
Upcoming Workouts (Next 2 days):
${upcomingText}
Your Tone & Persona: ${user.coach_tone || 'empathetic'}

MACRO BLOCK FOCUS RULES:
- If phase is BASE: Focus intensely on keeping their volume high and heart rate low (Zone 2). Discourage speedwork.
- If phase is BUILD: Focus on progressing their threshold and VO2max intervals. Tell them it's time to push.
- If phase is PEAK: Focus on race-specific intensity and sharpening. Keep them focused on executing race pace perfectly.
- If phase is TAPER: Focus heavily on recovery and shedding fatigue. Ensure they rest up for the race.

CRITICAL RULES:
1. Generate a single, highly personalized, proactive 1-2 sentence greeting for the athlete who just opened the app.
2. Analyze their fitness (CTL), fatigue (ATL), and readiness (TSB) from their Key Physiological Metrics. Reference these trends to steer the user towards action (e.g., prioritize recovery if TSB is very negative, or push hard if TSB is positive). You can also reference a recent/upcoming workout.
3. Keep it brief, extremely human, and supportive. 
4. DO NOT generate any JSON or workout plan updates. Just the greeting.`;

                    try {
                        let aiReply = await generateWithFallback("Generate the proactive greeting.", systemPrompt, []);
                        aiReply = aiReply.replace(/```json[\s\S]*?```/gi, '').trim();

                        db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'default')`, [req.user.id, aiReply]);
                        res.json({ reply: aiReply, mood: 'default' });
                    } catch (e) {
                        console.error("Checkin Server Error:", e);
                        res.status(500).json({ error: "AI failed to respond." });
                    }
                });
            });
        });
    });
});
app.get('/api/user/settings', authenticateToken, (req, res) => {
    db.get(
        `SELECT id, username, strava_refresh_token, garmin_username, coach_tone, athlete_context, search_privacy, profile_picture_url FROM users WHERE id = ?`,
        [req.user.id],
        (err, row) => {
            if (err || !row) return res.status(500).json({ error: "DB Error" });
            res.json({
                id: row.id,
                username: row.username,
                hasStrava: !!row.strava_refresh_token,
                hasGarmin: !!row.garmin_username,
                garminUsername: row.garmin_username,
                coachTone: row.coach_tone,
                athleteContext: row.athlete_context,
                searchPrivacy: row.search_privacy === 1,
                profilePictureUrl: row.profile_picture_url
            });
        }
    );
});

app.post('/api/user/settings/coach', authenticateToken, (req, res) => {
    const { coachTone, athleteContext } = req.body;

    db.run(
        `UPDATE users SET coach_tone = ?, athlete_context = ? WHERE id = ?`,
        [coachTone, athleteContext, req.user.id],
        function (err) {
            if (err) return res.status(500).json({ error: "Failed to update coach settings." });
            res.json({ message: "Coach updated successfully!" });
        }
    );
});

app.get('/api/user/metrics', authenticateToken, (req, res) => {
    db.all(`SELECT id, metric, value FROM athlete_metrics WHERE user_id = ? ORDER BY metric ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load metrics." });
        res.json(rows || []);
    });
});

app.post('/api/user/metrics', authenticateToken, (req, res) => {
    const { metrics } = req.body;
    if (!metrics || !Array.isArray(metrics)) {
        return res.status(400).json({ error: "Invalid metrics array format." });
    }

    db.serialize(() => {
        // We will just clear all custom metrics and re-insert what the user passed, or update them.
        // But some might have been auto-added by the AI, and we MUST preserve system metrics like strava_opt_out_activities.
        db.run(`DELETE FROM athlete_metrics WHERE user_id = ? AND metric != 'strava_opt_out_activities'`, [req.user.id]);
        const stmt = db.prepare(`INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, ?, ?)`);
        metrics.forEach(m => {
            if (m.metric !== 'strava_opt_out_activities') {
                stmt.run(req.user.id, m.metric, m.value);
            }
        });
        stmt.finalize();
        res.json({ message: "Metrics updated successfully!" });
    });
});

app.get('/api/user/activities/types', authenticateToken, (req, res) => {
    db.all(`SELECT DISTINCT sport_type FROM activities WHERE user_id = ? ORDER BY sport_type ASC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load activity types." });
        res.json(rows.map(r => r.sport_type));
    });
});

app.post('/api/user/strava-opt-out', authenticateToken, (req, res) => {
    const { optOutActivities } = req.body;
    if (!Array.isArray(optOutActivities)) {
        return res.status(400).json({ error: "optOutActivities must be an array" });
    }
    const val = JSON.stringify(optOutActivities);

    db.run(`INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, 'strava_opt_out_activities', ?) 
            ON CONFLICT(user_id, metric) DO UPDATE SET value=excluded.value`,
        [req.user.id, val], (err) => {
            if (err) return res.status(500).json({ error: "Failed to update preferences." });
            res.json({ success: true });
        });
});

app.post('/api/user/settings/garmin', authenticateToken, (req, res) => {
    const { garminUsername, garminPassword } = req.body;

    if (!garminUsername || !garminPassword) {
        return res.status(400).json({ error: "Username and password are required." });
    }

    const encryptedPassword = encrypt(garminPassword);

    db.run(
        `UPDATE users SET garmin_username = ?, garmin_password = ? WHERE id = ?`,
        [garminUsername, encryptedPassword, req.user.id],
        function (err) {
            if (err) return res.status(500).json({ error: "Failed to save Garmin credentials." });
            res.json({ message: "Garmin connection secured successfully!" });
        }
    );
});

app.post('/api/user/settings/strava', authenticateToken, (req, res) => {
    const { stravaRefreshToken } = req.body;

    if (!stravaRefreshToken) {
        return res.status(400).json({ error: "Missing Strava refresh token." });
    }

    db.run(
        `UPDATE users SET strava_refresh_token = ? WHERE id = ?`,
        [stravaRefreshToken, req.user.id],
        function (err) {
            if (err) return res.status(500).json({ error: "Failed to save Strava integration." });
            res.json({ message: "Strava connected successfully!" });
        }
    );
});

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
                tagStravaActivity(req.user.id, act, tokenData.access_token);
            });

            res.json({ message: `Successfully synced ${activities.length} activities!` });
        } catch (err) {
            console.error("Strava Sync Error:", err);
            res.status(500).json({ error: "Strava sync failed. Check server logs." });
        }
    });
});

app.get('/api/activity/:id', authenticateToken, (req, res) => {
    const activityId = req.params.id;

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
            if (!tokenData.access_token) {
                return res.status(401).json({ error: "Strava rejected the token." });
            }

            const actRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });

            if (!actRes.ok) {
                return res.status(actRes.status).json({ error: "Activity not found on Strava." });
            }

            const activityData = await actRes.json();

            // Extract sets or best efforts for the AI Coach
            let extractedSets = [];

            if (activityData.best_efforts && activityData.best_efforts.length > 0) {
                extractedSets = activityData.best_efforts.map(be => ({
                    name: be.name,
                    time: be.moving_time,
                    distance: be.distance
                }));
            }
            // Strava strength training structure (defensive parsing)
            if (activityData.sport_type === 'WeightTraining') {
                // Try to pull from sets, exercises, or laps (depending on how partner apps sync)
                if (activityData.sets) extractedSets = activityData.sets;
                else if (activityData.exercises) extractedSets = activityData.exercises;
                else if (activityData.laps) extractedSets = activityData.laps; // sometimes sets are stored as laps
            }

            if (extractedSets.length > 0) {
                db.run(`UPDATE activities SET sets_json = ? WHERE id = ?`, [JSON.stringify(extractedSets), activityId]);
                activityData.sets_json = extractedSets; // attach for frontend
            }

            res.json(activityData);

        } catch (err) {
            console.error("Single Activity Fetch Error:", err);
            res.status(500).json({ error: "Failed to fetch activity details." });
        }
    });
});

app.post('/api/user/settings/strava-exchange', authenticateToken, async (req, res) => {
    const { code } = req.body;

    if (!code) return res.status(400).json({ error: "No authorization code provided." });

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

        if (data.errors) return res.status(400).json({ error: "Strava rejected the authorization." });

        db.run(`UPDATE users SET strava_refresh_token = ? WHERE id = ?`, [data.refresh_token, req.user.id]);

        db.run(
            `INSERT OR REPLACE INTO strava_tokens (user_id, access_token, refresh_token, expires_at, strava_id) VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, data.access_token, data.refresh_token, data.expires_at, String(data.athlete.id)],
            (err) => {
                if (err) return res.status(500).json({ error: "Failed to map Strava ID." });
                res.json({ message: "Strava connected successfully!" });
            }
        );

    } catch (error) {
        res.status(500).json({ error: "Server error during Strava authentication." });
    }
});

app.post('/api/user/disconnect/strava', authenticateToken, (req, res) => {
    db.get(`SELECT access_token FROM strava_tokens WHERE user_id = ?`, [req.user.id], async (err, row) => {
        if (row && row.access_token) {
            try {
                await fetch('https://www.strava.com/oauth/deauthorize', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${row.access_token}` }
                });
            } catch (e) {
                console.error("Failed to deauthorize Strava:", e);
            }
        }
        db.run(`UPDATE users SET strava_refresh_token = NULL WHERE id = ?`, [req.user.id]);
        db.run(`DELETE FROM strava_tokens WHERE user_id = ?`, [req.user.id], (err) => {
            if (err) return res.status(500).json({ error: "Failed to disconnect Strava from database." });
            res.json({ message: "Strava disconnected successfully!" });
        });
    });
});

app.post('/api/user/disconnect/garmin', authenticateToken, (req, res) => {
    db.run(`UPDATE users SET garmin_username = NULL, garmin_password = NULL WHERE id = ?`, [req.user.id], (err) => {
        if (err) return res.status(500).json({ error: "Failed to disconnect Garmin." });
        res.json({ message: "Garmin disconnected successfully!" });
    });
});

app.get('/api/dashboard-data', authenticateToken, (req, res) => {
    db.all(`SELECT substr(start_date, 1, 10) as date, sport_type, SUM(spark_score) as daily_spark FROM activities WHERE user_id = ? GROUP BY date, sport_type ORDER BY date ASC`, [req.user.id], (err, rows) => {
        if (!rows) return res.json([]);
        const aggregated = {};
        rows.forEach(r => {
            const mappedSport = mapStravaSportToSpark(r.sport_type);
            const key = `${r.date}_${mappedSport}`;
            if (!aggregated[key]) aggregated[key] = { date: r.date, sport_type: mappedSport, daily_spark: 0 };
            aggregated[key].daily_spark += r.daily_spark;
        });
        res.json(Object.values(aggregated));
    });
});

app.get('/api/history', authenticateToken, (req, res) => {
    db.all(`SELECT id, name, sport_type, start_date, spark_score FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 50`, [req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/micro-plan', authenticateToken, (req, res) => {
    const { date, sport, description, target_spark, details, steps_json } = req.body;
    db.run(
        `INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, date, sport, description, target_spark, details, steps_json || '[]'],
        (err) => {
            if (err) {
                console.error("POST /api/micro-plan error:", err.message);
                return res.status(500).json({ error: "Failed to create plan", details: err.message });
            }
            res.json({ success: true });
        }
    );
});

app.post('/api/micro-plan/day', authenticateToken, (req, res) => {
    const { date, workouts } = req.body;
    if (!date || !Array.isArray(workouts)) return res.status(400).json({ error: "Invalid data format" });

    db.run(`DELETE FROM micro_plan WHERE user_id = ? AND date = ?`, [req.user.id, date], (err) => {
        if (err) return res.status(500).json({ error: "Failed to update plan" });

        if (workouts.length === 0) return res.json({ success: true });

        const stmt = db.prepare(`INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        workouts.forEach(w => {
            stmt.run(req.user.id, date, w.sport, w.description, w.target_spark, w.details, w.steps_json || '[]');
        });
        stmt.finalize();
        res.json({ success: true });
    });
});
app.put('/api/micro-plan/:id', authenticateToken, (req, res) => {
    const { date, sport, description, target_spark, details, steps_json } = req.body;
    db.run(
        `UPDATE micro_plan SET date = ?, sport = ?, description = ?, target_spark = ?, details = ?, steps_json = ? WHERE id = ? AND user_id = ?`,
        [date, sport, description, target_spark, details, steps_json, req.params.id, req.user.id],
        (err) => {
            if (err) {
                console.error("PUT /api/micro-plan error:", err.message);
                return res.status(500).json({ error: "Failed to update plan", details: err.message });
            }
            res.json({ success: true });
        }
    );
});

app.delete('/api/micro-plan/:id', authenticateToken, (req, res) => {
    db.run(
        `DELETE FROM micro_plan WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.id],
        (err) => {
            if (err) return res.status(500).json({ error: "Failed to delete plan" });
            res.json({ success: true });
        }
    );
});

app.post('/api/generate-plan', authenticateToken, async (req, res) => {
    const { targetDate } = req.body;

    db.get(`SELECT coach_tone, athlete_context FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err) {
            console.error("DB Error fetching user context for plan generation:", err);
            return res.status(500).json({ error: "Failed to load athlete context." });
        }
        if (!user) {
            return res.status(500).json({ error: "Athlete context not found." });
        }

        db.all(`SELECT metric, value FROM athlete_metrics WHERE user_id = ?`, [req.user.id], async (err, metricsRows) => {
            const metricsText = (metricsRows && metricsRows.length > 0)
                ? metricsRows.map(m => `${m.metric}: ${m.value}`).join(', ')
                : 'None explicitly recorded yet.';

            db.all(`SELECT sport_type, start_date, sets_json FROM activities WHERE user_id = ? AND sets_json IS NOT NULL AND sets_json != '[]' ORDER BY start_date DESC LIMIT 5`, [req.user.id], async (err, recentSetsRows) => {
                let recentSetsText = "No recent strength/PB data recorded.";
                if (recentSetsRows && recentSetsRows.length > 0) {
                    recentSetsText = recentSetsRows.map(row => `Date: ${row.start_date}, Sport: ${row.sport_type}, Details: ${row.sets_json}`).join('\n');
                }

                const systemPrompt = `You are Coach Spark, an elite Ironman Triathlon and endurance coach.
            Tone: ${user.coach_tone || 'empathetic'}
            Athlete Context: ${user.athlete_context || 'General endurance athlete'}
            Key Physiological Metrics: ${metricsText}
            Recent Strength & PB History:
            ${recentSetsText}
        
        CRITICAL RULES:
        1. You are generating a 7-day training plan starting exactly on ${targetDate}.
        2. You must append a JSON code block at the very end of your response containing the schedule.
        3. Use metric measurements exclusively (km, kg, km/h). DO NOT repeat greetings, filler words, or preamble.
        4. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout, create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
        5. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Use simple, standard exercise names (e.g., "Barbell Back Squat", "Dumbbell Lunge"). Between sets, use a "rest" step with "condition_type": "time_sec" and set "condition_value" to the number of SECONDS to rest (e.g., 90 for 90 seconds). Reference the Athlete Context for their past weights, and push for progressive overload.
        6. TARGETS: If a workout requires a specific pace (e.g. "4:15 min/km") or power (e.g. "250W") instead of a generic zone, add a "target_value" string to the step object (e.g., "target_value": "4:15 min/km"). Otherwise, continue using "zone": <number>.
        7. SPARK TARGETS: Calculate "target_spark" for your plan. 1 minute of activity = 1 Spark (add +20% for high intensity). For Strength Training, assume each set takes 1 minute of work, plus the rest time between sets, to estimate the total duration and resulting target_spark.

        WORKOUT PLANNING (CRITICAL):
        If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
        The JSON must be a valid Array of objects. Format it EXACTLY JSON FORMAT REQUIRED AT THE END OF YOUR RESPONSE:
        \`\`\`json
        [
          {
            "date": "YYYY-MM-DD",
            "sport": "Run", 
            "description": "5k Speed Intervals",
            "target_spark": 80,
            "details": "Push hard on the intervals, recover fully on the rests.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
          },
          {
            "date": "YYYY-MM-DD",
            "sport": "Strength", 
            "description": "Leg Day Burner",
            "target_spark": 40,
            "details": "Focus on depth and explosion.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 5, \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"repeat\\", \\"iterations\\": 3, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"reps\\", \\"condition_value\\": 10, \\"weight\\": 80, \\"exerciseName\\": \\"Barbell Squat\\", \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"rest\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 2, \\"target_type\\": \\"no.target\\"}]}]"
          }
        ]
        \`\`\`
        *Note: Ensure "steps_json" is formatted as a stringified JSON array as shown in the examples. Exercises MUST go in steps_json, NOT details!*`;

                const ctl = user.current_ctl || 0;
                const atl = user.current_atl || 0;
                const tsb = ctl - atl;
                const phase = user.training_phase || 'Base';

                const userPrompt = `Please generate a 7-day training plan for me starting on ${targetDate}. 
        
        Here are my current physiological metrics to govern the volume and intensity of this block:
        - Training Phase: ${phase}
        - Fitness (CTL): ${ctl}
        - Fatigue (ATL): ${atl}
        - Form (TSB): ${tsb}

        Analyze my Form (TSB). If I am highly fatigued (negative TSB), prioritize recovery. If I am fresh (positive TSB), you can push the intensity. Give me a quick encouraging summary of the week's focus based on these metrics, and then provide the JSON block.`;

                try {
                    let aiReply = await generateWithFallback(userPrompt, systemPrompt);
                    let planUpdated = false;

                    const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
                    if (jsonMatch) {
                        try {
                            const planData = JSON.parse(jsonMatch[1]);
                            const affectedDates = [...new Set(planData.map(day => day.date))];

                            if (affectedDates.length > 0) {
                                const placeholders = affectedDates.map(() => '?').join(',');

                                db.run(`DELETE FROM micro_plan WHERE user_id = ? AND date IN (${placeholders})`, [req.user.id, ...affectedDates], (err) => {
                                    if (err) console.error("Failed to clear old plan data:", err);

                                    const stmt = db.prepare(`
                                INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) 
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `);

                                    planData.forEach(day => {
                                        stmt.run(req.user.id, day.date, day.sport, day.description, day.target_spark, day.details, day.steps_json || '[]');
                                    });
                                    stmt.finalize();
                                });
                            }

                            planUpdated = true;
                            aiReply = aiReply.replace(/```json[\s\S]*?```/, '').trim();
                        } catch (e) {
                            console.error("Failed to parse AI JSON block", e);
                        }
                    }

                    let mood = 'default';
                    const lowerReply = aiReply.toLowerCase();
                    if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
                    if (lowerReply.includes('disappoint') || lowerReply.includes('skip')) mood = 'disappointed';

                    const simulatedUserMessage = `Can you build my plan for next week, Spark?`;
                    const coachAcknowledgement = `I've just crunched your latest numbers and pushed a fresh ${phase} phase plan to your dashboard. Go check it out—you're going to crush it!`;

                    db.run(`INSERT INTO chat_history (user_id, role, content) VALUES (?, 'user', ?)`, [req.user.id, simulatedUserMessage]);
                    db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`, [req.user.id, coachAcknowledgement, mood]);
                    res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });
                } catch (e) {
                    console.error("AI Generation Error:", e);
                    res.status(500).json({ error: "AI failed to respond." });
                }
            }); // End activities fetch
        }); // End metrics fetch
    });
});

app.get('/api/admin/usage', authenticateToken, (req, res) => {
    const isRutger = req.user.username && req.user.username.toLowerCase().includes('rutger');
    if (!isRutger && req.user.id !== 1) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    const query = `
        SELECT 
            u.username, 
            u.login_count, 
            u.chat_count,
            u.daily_token_usage,
            CASE WHEN u.strava_refresh_token IS NOT NULL AND u.strava_refresh_token != '' THEN 1 ELSE 0 END as strava_connected,
            CASE WHEN u.garmin_username IS NOT NULL AND u.garmin_username != '' THEN 1 ELSE 0 END as garmin_connected,
            (SELECT COUNT(*) FROM activities WHERE user_id = u.id) as activities_count
        FROM users u
        ORDER BY u.login_count DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(rows || []);
    });
});

app.get('/api/social/feed', authenticateToken, async (req, res) => {
    db.all(`
        SELECT a.id, a.user_id, a.name, a.distance_km, a.moving_time_min, a.start_date, a.sport_type, a.tss as spark_score, u.username, u.profile_picture_url
        FROM activities a
        JOIN users u ON a.user_id = u.id
        ORDER BY a.start_date DESC LIMIT 50
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({ activities: rows });
    });
});

// Function to generate the public profile data
function generatePublicProfile(targetUserId, globalMaxStats) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT username, athlete_context, profile_picture_url FROM users WHERE id = ?`, [targetUserId], (err, user) => {
            if (err || !user) return resolve(null);
            
            db.all(`SELECT id, name, distance_km, moving_time_min, start_date, sport_type, tss as spark_score FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`, [targetUserId], async (err, activities) => {
                
                db.all(`SELECT start_date, substr(start_date, 1, 10) as date, tss, sport_type, distance_km, elevation_m, moving_time_min FROM activities WHERE user_id = ? ORDER BY start_date ASC`, [targetUserId], async (err, rows) => {
                    
                    db.all(`SELECT date, weight_kg FROM biometrics WHERE user_id = ? AND date >= date('now', '-30 days') ORDER BY date ASC`, [targetUserId], async (err, weights) => {
                        
                        const trends = { dates: [], tsb: [], ctl: [], atl: [], weight: [] };
                        
                        const tssMap = {};
                        let earliestDateStr = null;
                        if (rows && rows.length > 0) {
                            earliestDateStr = rows[0].date;
                            rows.forEach(r => {
                                if (!tssMap[r.date]) tssMap[r.date] = 0;
                                tssMap[r.date] += (r.tss || 0);
                            });
                        }
                        const weightMap = {};
                        if (weights) weights.forEach(w => weightMap[w.date] = w.weight_kg || null);

                        let ctl = 0; let atl = 0;
                        if (earliestDateStr) {
                            let currentDate = new Date(earliestDateStr);
                            const today = new Date();
                            currentDate.setUTCHours(0,0,0,0);
                            today.setUTCHours(0,0,0,0);
                            
                            // Calculate how many days to push to trends
                            const totalDays = Math.round((today - currentDate) / (1000 * 60 * 60 * 24));
                            const trendStartIdx = totalDays - 29; // We only want the last 30 days
                            
                            let currentDayIdx = 0;
                            while (currentDate <= today) {
                                const dateStr = currentDate.toISOString().split('T')[0];
                                
                                const dailyTss = tssMap[dateStr] || 0;
                                ctl = ctl + (dailyTss - ctl) * (1 - Math.exp(-1/42));
                                atl = atl + (dailyTss - atl) * (1 - Math.exp(-1/7));
                                
                                if (currentDayIdx >= trendStartIdx) {
                                    trends.dates.push(dateStr);
                                    trends.ctl.push(ctl);
                                    trends.atl.push(atl);
                                    trends.tsb.push(ctl - atl);
                                    trends.weight.push(weightMap[dateStr] || null);
                                }
                                
                                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                                currentDayIdx++;
                            }
                        }

                        let endurance = Math.min(100, Math.round((ctl / globalMaxStats.ctl) * 100));
                        let weightTrainingCount = rows ? rows.filter(r => r.sport_type === 'WeightTraining').length : 0;
                        let totalElevation = rows ? rows.reduce((sum, r) => sum + (r.elevation_m || 0), 0) : 0;
                        let strengthScore = (weightTrainingCount * 5) + (totalElevation / 1000); 
                        let strength = Math.min(100, Math.round((strengthScore / globalMaxStats.strength) * 100));
                        const uniqueSports = new Set(rows ? rows.map(r => r.sport_type) : []).size;
                        let versatility = Math.min(100, Math.round((uniqueSports / globalMaxStats.versatility) * 100));
                        let explosiveSessions = rows ? rows.filter(r => (r.tss / (r.moving_time_min || 1)) > 1.2).length : 0;
                        let explosiveness = Math.min(100, Math.round((explosiveSessions / globalMaxStats.explosiveness) * 100));

                        const radar = { endurance: endurance || 10, strength: strength || 10, versatility: versatility || 10, explosiveness: explosiveness || 10 };

                        const genericCoachTone = "Empathetic but demanding elite endurance coach.";
                        const currentTsb = trends.tsb.length > 0 ? Math.round(trends.tsb[trends.tsb.length - 1]) : 0;
                        const prompt = `Write a 2-3 sentence "Coach Highlight" about ${user.username} (refer to them in the third person, e.g., "${user.username} is..."). 
Recent Activities: ${activities.map(a => a.name).join(', ')}
Current Chronic Training Load (Fitness): ${Math.round(ctl)}
Current Training Stress Balance (Readiness): ${currentTsb}

Write this from the perspective of their coach (Tone: ${genericCoachTone}). Keep it brief, dynamic, and highly personalized based on their recent activities and current readiness! Talk about them to an audience. Do not mention their hidden background or context. Do not include any markdown bolding or headers.`;

                        let highlight = "Keep pushing! They're doing great.";
                        try {
                            highlight = await generateWithFallback("Generate public profile highlight", prompt, []);
                        } catch (e) {
                            console.error("Highlight generation failed", e);
                        }

                        const profileData = {
                            username: user.username,
                            profilePictureUrl: user.profile_picture_url,
                            highlight: highlight,
                            activities: activities,
                            trends: trends,
                            radar: radar
                        };
                        
                        db.run(`INSERT OR REPLACE INTO public_profile_cache (user_id, data, last_updated) VALUES (?, ?, datetime('now'))`, [targetUserId, JSON.stringify(profileData)]);
                        resolve(profileData);
                    });
                });
            });
        });
    });
}

async function calculateGlobalMaxStats() {
    return new Promise((resolve) => {
        db.all(`SELECT user_id, start_date, substr(start_date, 1, 10) as date, tss, sport_type, elevation_m, moving_time_min FROM activities ORDER BY start_date ASC`, [], (err, rows) => {
            if (err || !rows) return resolve({ ctl: 1, strength: 1, versatility: 1, explosiveness: 1 });
            
            const userStats = {};
            rows.forEach(r => {
                if (!userStats[r.user_id]) {
                    userStats[r.user_id] = { 
                        ctlMap: {}, earliest: r.date, 
                        weightTrainingCount: 0, totalElevation: 0, 
                        uniqueSports: new Set(), explosiveSessions: 0 
                    };
                }
                const stats = userStats[r.user_id];
                if (!stats.earliest) stats.earliest = r.date;
                
                stats.ctlMap[r.date] = (stats.ctlMap[r.date] || 0) + (r.tss || 0);
                
                if (r.sport_type === 'WeightTraining') stats.weightTrainingCount++;
                stats.totalElevation += (r.elevation_m || 0);
                if (r.sport_type) stats.uniqueSports.add(r.sport_type);
                if (r.moving_time_min && (r.tss / r.moving_time_min) > 1.2) stats.explosiveSessions++;
            });

            let globalMax = { ctl: 1, strength: 1, versatility: 1, explosiveness: 1 };
            
            Object.keys(userStats).forEach(uid => {
                const stats = userStats[uid];
                
                let ctl = 0;
                if (stats.earliest) {
                    let currentDate = new Date(stats.earliest);
                    const today = new Date();
                    currentDate.setUTCHours(0,0,0,0);
                    today.setUTCHours(0,0,0,0);
                    while (currentDate <= today) {
                        const dateStr = currentDate.toISOString().split('T')[0];
                        const dailyTss = stats.ctlMap[dateStr] || 0;
                        ctl = ctl + (dailyTss - ctl) * (1 - Math.exp(-1/42));
                        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                    }
                }
                
                let strengthScore = (stats.weightTrainingCount * 5) + (stats.totalElevation / 1000);
                let versatilityScore = stats.uniqueSports.size;
                let explosivenessScore = stats.explosiveSessions;

                if (ctl > globalMax.ctl) globalMax.ctl = ctl;
                if (strengthScore > globalMax.strength) globalMax.strength = strengthScore;
                if (versatilityScore > globalMax.versatility) globalMax.versatility = versatilityScore;
                if (explosivenessScore > globalMax.explosiveness) globalMax.explosiveness = explosivenessScore;
            });
            resolve(globalMax);
        });
    });
}

async function generateAllPublicProfiles() {
    console.log("🕒 Running 15:00 / 20:00 Profile Caching Routine...");
    // 1. Calculate Global Max Stats using ALL activities
    const globalMaxStats = await calculateGlobalMaxStats();
    console.log(`[Cache] Global Max Stats calculated as:`, globalMaxStats);

    // 2. Iterate all users and generate profile
        db.all(`SELECT id FROM users`, [], async (err, users) => {
            if (err || !users) return;
            for (const u of users) {
                await generatePublicProfile(u.id, globalMaxStats);
                // sleep 2s to not hammer AI
                await new Promise(r => setTimeout(r, 2000));
            }
            console.log("✅ All public profiles (Radar Charts & AI Highlights) have been successfully generated and cached!");
        });
}

// Background Task for 15:00 and 20:00
setInterval(() => {
    const now = new Date();
    // Run at exactly 15:00 and 20:00
    if ((now.getHours() === 15 || now.getHours() === 20) && now.getMinutes() === 0) {
        generateAllPublicProfiles();
    }
}, 60000); // Check every minute

// Prime the cache on server startup
setTimeout(() => {
    console.log("Starting initial profile caching...");
    generateAllPublicProfiles();
}, 5000);

app.get('/api/social/profile/:id', authenticateToken, (req, res) => {
    const targetUserId = req.params.id;
    
    db.get(`SELECT data FROM public_profile_cache WHERE user_id = ?`, [targetUserId], async (err, row) => {
        if (row && row.data) {
            return res.json(JSON.parse(row.data));
        } else {
            // Fallback generation if missing
            const globalMaxStats = await calculateGlobalMaxStats();
            const profileData = await generatePublicProfile(targetUserId, globalMaxStats);
            if (profileData) res.json(profileData);
            else res.status(404).json({ error: "User not found" });
        }
    });
});

app.post('/api/sync-garmin', authenticateToken, async (req, res) => {
    console.log("DEBUG: Sync route triggered for user:", req.user.id);
    const selectedWorkouts = req.body.workouts;

    if (!selectedWorkouts || selectedWorkouts.length === 0) {
        return res.status(400).json({ error: "No workouts selected for sync." });
    }

    try {
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT garmin_username, garmin_password FROM users WHERE id = ?`, [req.user.id], (err, row) => {
                if (err || !row) reject(new Error("User credentials not found"));
                else resolve(row);
            });
        });

        const decryptedPassword = decrypt(user.garmin_password);
        const GCClient = new GarminConnect({ username: user.garmin_username, password: decryptedPassword });

        console.log("DEBUG: Attempting login for user:", user.garmin_username);
        await GCClient.login(user.garmin_username, decryptedPassword);
        const client = GCClient.client || GCClient.http;
        if (!client) throw new Error("Garmin client initialization failed.");

        const todayStr = getAMSDateString();
        const workouts = await new Promise((resolve, reject) => {
            db.all(`SELECT date, sport, description, target_spark, steps_json FROM micro_plan WHERE user_id = ? AND date >= ?`,
                [req.user.id, todayStr], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
        });

        const workoutsToSync = workouts.filter(w =>
            selectedWorkouts.some(sw => sw.date === w.date && sw.sport === w.sport)
        );

        if (workoutsToSync.length === 0) return res.status(400).json({ error: "No valid workouts found to sync." });

        let syncedCount = 0;

        for (const workout of workoutsToSync) {
            if (workout.sport === 'Rest' || !SPORT_MAP[workout.sport]) continue;

            const sportDef = SPORT_MAP[workout.sport];
            let stepsArray = [];
            try { stepsArray = JSON.parse(workout.steps_json); } catch (e) { stepsArray = []; }

            if (stepsArray.length === 0) {
                let durationMins = Math.max(5, Math.round((workout.target_spark / 55) * 60));
                stepsArray = [{ type: 'interval', condition_type: 'time', condition_value: durationMins, target_type: 'no.target' }];
            }

            const garminSteps = stepsArray.map((step, index) => {
                if (step.type === 'repeat') {
                    return {
                        type: "RepeatGroupDTO",
                        stepOrder: index + 1,
                        smartRepeat: false,
                        numberOfIterations: step.iterations || 1,
                        workoutSteps: (step.steps || []).map((subStep, subIndex) => {
                            const nType = (subStep.type === 'drill') ? 'interval' : subStep.type;
                            const sDef = STEP_TYPE_MAP[nType] || STEP_TYPE_MAP['interval'];
                            const tDef = TARGET_TYPE_MAP[subStep.target_type] || TARGET_TYPE_MAP['no.target'];
                            const cDef = CONDITION_TYPE_MAP[subStep.condition_type] || CONDITION_TYPE_MAP['time'];

                            const sDTO = {
                                type: "ExecutableStepDTO",
                                stepOrder: subIndex + 1,
                                stepType: { stepTypeId: sDef.id, stepTypeKey: sDef.key },
                                endCondition: { conditionTypeId: cDef.id, conditionTypeKey: cDef.key },
                                endConditionValue: subStep.condition_type === 'time' ? subStep.condition_value * 60 : subStep.condition_value,
                                targetType: { workoutTargetTypeId: tDef.id, workoutTargetTypeKey: tDef.key },
                                targetValueOne: null, targetValueTwo: null,
                                zoneNumber: subStep.zone ? parseInt(subStep.zone, 10) : null
                            };
                            if (subStep.target_value) {
                                if (subStep.target_value.includes('min/km') || subStep.target_type === 'pace.exact') {
                                    const match = subStep.target_value.match(/(\d+):(\d+)/);
                                    if (match) {
                                        const speedMs = 1000 / ((parseInt(match[1], 10) * 60) + parseInt(match[2], 10));
                                        sDTO.targetType = { workoutTargetTypeId: TARGET_TYPE_MAP['pace.zone'].id, workoutTargetTypeKey: TARGET_TYPE_MAP['pace.zone'].key };
                                        sDTO.targetValueOne = speedMs * 0.95;
                                        sDTO.targetValueTwo = speedMs * 1.05;
                                        sDTO.zoneNumber = null;
                                    }
                                } else if (subStep.target_value.toLowerCase().includes('w')) {
                                    const match = subStep.target_value.match(/(\d+)/);
                                    if (match) {
                                        const watts = parseInt(match[1], 10);
                                        sDTO.targetType = { workoutTargetTypeId: TARGET_TYPE_MAP['power.zone'].id, workoutTargetTypeKey: TARGET_TYPE_MAP['power.zone'].key };
                                        sDTO.targetValueOne = watts * 0.90;
                                        sDTO.targetValueTwo = watts * 1.10;
                                        sDTO.zoneNumber = null;
                                    }
                                }
                            }
                            if (subStep.condition_type === 'distance') {
                                sDTO.preferredEndConditionUnit = { unitId: 1, unitKey: "meter", factor: 100 };
                            }
                            if (subStep.weight) {
                                sDTO.weightValue = subStep.weight;
                                sDTO.weightUnit = { unitId: 9, unitKey: "kilogram" };
                            }
                            if (subStep.exerciseName) {
                                const match = matchGarminExercise(subStep.exerciseName);
                                if (match) {
                                    sDTO.category = match.category_key;
                                    sDTO.exerciseName = match.exercise_key;
                                } else {
                                    sDTO.description = subStep.exerciseName; // Fallback to notes if no match
                                }
                            }
                            return sDTO;
                        })
                    };
                }

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
                if (step.target_value) {
                    if (step.target_value.includes('min/km') || step.target_type === 'pace.exact') {
                        const match = step.target_value.match(/(\d+):(\d+)/);
                        if (match) {
                            const speedMs = 1000 / ((parseInt(match[1], 10) * 60) + parseInt(match[2], 10));
                            stepDTO.targetType = { workoutTargetTypeId: TARGET_TYPE_MAP['pace.zone'].id, workoutTargetTypeKey: TARGET_TYPE_MAP['pace.zone'].key };
                            stepDTO.targetValueOne = speedMs * 0.95;
                            stepDTO.targetValueTwo = speedMs * 1.05;
                            stepDTO.zoneNumber = null;
                        }
                    } else if (step.target_value.toLowerCase().includes('w')) {
                        const match = step.target_value.match(/(\d+)/);
                        if (match) {
                            const watts = parseInt(match[1], 10);
                            stepDTO.targetType = { workoutTargetTypeId: TARGET_TYPE_MAP['power.zone'].id, workoutTargetTypeKey: TARGET_TYPE_MAP['power.zone'].key };
                            stepDTO.targetValueOne = watts * 0.90;
                            stepDTO.targetValueTwo = watts * 1.10;
                            stepDTO.zoneNumber = null;
                        }
                    }
                }

                if (step.condition_type === 'distance') {
                    stepDTO.preferredEndConditionUnit = { unitId: 1, unitKey: "meter", factor: 100 };
                }
                if (step.weight) {
                    stepDTO.weightValue = step.weight;
                    stepDTO.weightUnit = { unitId: 9, unitKey: "kilogram" };
                }
                if (step.exerciseName) {
                    const match = matchGarminExercise(step.exerciseName);
                    if (match) {
                        stepDTO.category = match.category_key;
                        stepDTO.exerciseName = match.exercise_key;
                    } else {
                        stepDTO.description = step.exerciseName; // Fallback to notes if no match
                    }
                }
                return stepDTO;
            });

            const wkt = {
                workoutName: `Spark: ${workout.sport}`,
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

        res.json({ success: true, message: `Successfully pushed ${syncedCount} structured workouts!` });

    } catch (err) {
        console.error("CRITICAL ERROR in sync-garmin:", err);
        return res.status(500).json({ error: "Server sync failed", details: err.message });
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
        milestones.forEach(m => {
            stmt.run(req.user.id, m.name, m.date, m.target_ctl, m.is_main ? 1 : 0);
        });
        stmt.finalize();

        res.json({ success: true, message: "Calendar updated!" });
    });
});

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
app.get('/api/physique', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM physique_logs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch physique logs." });
        res.json(rows);
    });
});

// Secure Image Endpoints
app.get('/api/images/physique/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    if (!filename.startsWith(`physique_${req.user.id}_`)) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this image." });
    }
    const filePath = path.join(__dirname, 'secure_uploads/physique', filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
});

app.get('/api/images/chat/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    if (!filename.startsWith(`img_${req.user.id}_`)) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this image." });
    }
    const filePath = path.join(__dirname, 'secure_uploads/chat_images', filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
});

app.post('/api/physique', authenticateToken, uploadPhysique.single('photo'), async (req, res) => {
    const { date, weight_kg, sleep_quality, fatigue_level, notes } = req.body;
    const photoUrl = req.file ? `/api/images/physique/${req.file.filename}` : null;

    db.run(
        `INSERT INTO physique_logs (user_id, date, weight_kg, sleep_quality, fatigue_level, notes, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, date, weight_kg || null, sleep_quality || null, fatigue_level || null, notes || null, photoUrl],
        async function (err) {
            if (err) return res.status(500).json({ error: "Failed to save physique log." });

            // Also insert weight into biometrics for charting
            if (weight_kg) {
                db.run(`INSERT INTO biometrics (user_id, date, weight_kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg=excluded.weight_kg`, [req.user.id, date, weight_kg]);
            }

            res.json({ success: true });

            // Proactive AI Coach message
            try {
                let prompt = `The athlete just logged their daily physique and wellness data for ${date}.\\n`;
                if (weight_kg) prompt += `Weight: ${weight_kg}kg\\n`;
                if (sleep_quality) prompt += `Sleep Quality (1-5): ${sleep_quality}\\n`;
                if (fatigue_level) prompt += `Fatigue Level (1-5): ${fatigue_level}\\n`;
                if (notes) prompt += `Notes: ${notes}\\n`;

                let imageBase64 = null;
                if (req.file) {
                    prompt += `They also uploaded a progress photo (attached).\\n`;
                    const imageBytes = fs.readFileSync(req.file.path);
                    imageBase64 = imageBytes.toString('base64');
                }

                db.all(`SELECT sport, description, target_spark FROM micro_plan WHERE user_id = ? AND date = ?`, [req.user.id, date], (err, planRows) => {
                    if (planRows && planRows.length > 0) {
                        prompt += `Their planned workouts for today are: ` + planRows.map(r => `${r.sport} (${r.description})`).join(', ') + `.\\n`;
                    } else {
                        prompt += `They have a Rest day planned for today.\\n`;
                    }

                    prompt += `Review their status. Keep it under 2 sentences, act as their friendly elite endurance coach, and give them a short piece of advice or encouragement based on their numbers (and the photo if attached).`;

                    db.get("SELECT coach_tone FROM users WHERE id = ?", [req.user.id], async (err, row) => {
                        const tone = row ? row.coach_tone : 'Friendly';
                        const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${tone}. Act like a real human in a continuous text message thread.`;
                        try {
                            const aiReply = await generateWithFallback(prompt, systemPrompt, null, imageBase64);
                            db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`, [req.user.id, aiReply]);
                            sendSSEEvent(req.user.id, 'unread_message', { message: aiReply, mood: 'support' });
                        } catch (e) {
                            console.error("Proactive AI generation for physique failed:", e);
                        }
                    });
                });

            } catch (e) {
                console.error("Proactive AI generation for physique failed:", e);
            }
        }
    );
});

app.delete('/api/physique/:id', authenticateToken, (req, res) => {
    // First find the date so we can optionally remove the biometric weight log for that day
    db.get(`SELECT date FROM physique_logs WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id], (err, row) => {
        if (!row) return res.status(404).json({ error: "Log not found." });

        db.run(`DELETE FROM physique_logs WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: "Failed to delete log." });

            // Also nullify/remove weight from biometrics for this date if we are deleting the physique log
            // (Assuming weight_kg was the primary entry method for that date)
            db.run(`DELETE FROM biometrics WHERE user_id = ? AND date = ?`, [req.user.id, row.date]);

            res.json({ success: true });
        });
    });
});
app.get('/api/physique/nutrition', authenticateToken, async (req, res) => {
    const todayStr = new Date().toISOString().split('T')[0];

    db.get(`SELECT protocol_json FROM nutrition_protocols WHERE user_id = ? AND date = ?`, [req.user.id, todayStr], async (err, cachedRow) => {
        if (cachedRow && cachedRow.protocol_json) {
            try {
                return res.json(JSON.parse(cachedRow.protocol_json));
            } catch (e) {
                // Parse error, ignore and regenerate
                console.error("Cache parse error", e);
            }
        }

        db.get(`SELECT weight_kg FROM biometrics WHERE user_id = ? ORDER BY date DESC LIMIT 1`, [req.user.id], async (err, weightRow) => {
            const weight = weightRow ? weightRow.weight_kg : 75; // Default to 75kg if unknown
            const phase = await getUserMacroPhase(req.user.id);

            // Fetch today's completed activities (if any)
            db.all(`SELECT SUM(spark_score) as total_score FROM activities WHERE user_id = ? AND date(start_date) = ?`, [req.user.id, todayStr], (err, actualAct) => {
                const actualSpark = actualAct && actualAct.length > 0 && actualAct[0].total_score ? actualAct[0].total_score : 0;

                db.all(`SELECT date, target_spark, description FROM micro_plan WHERE user_id = ? AND date = ? LIMIT 1`, [req.user.id, todayStr], async (err, todayPlan) => {
                    let todaySpark = todayPlan && todayPlan.length > 0 ? todayPlan[0].target_spark : 0;
                    let todayDesc = todayPlan && todayPlan.length > 0 ? todayPlan[0].description : 'Rest day';

                    // If they already trained harder than planned (or trained on a rest day), update the prompt
                    if (actualSpark > todaySpark || (actualSpark > 0 && todayDesc === 'Rest day')) {
                        todaySpark = actualSpark;
                        todayDesc = 'Completed Workout / Training Day';
                    }

                    const systemPrompt = `You are an elite sports nutritionist. The user is an endurance athlete currently in their ${phase} phase.
Their latest weight is ${weight}kg.
Today's training load/plan: ${todayDesc} (Spark Points: ${todaySpark}).

Based on today's training load and their current macro phase, recommend a daily macro nutrition target.
- For high Spark Points / intense days, prescribe higher carbohydrates.
- For rest / low Spark Points days, prescribe lower carbohydrates and higher protein/fat.
- Ensure total calories make sense for an endurance athlete of their weight.

You MUST respond with ONLY a raw JSON object containing exactly these keys:
{
  "title": "String (e.g. 'High Carb / Big Session')",
  "rationale": "String (1-2 sentences explaining why)",
  "carbs": Number (grams),
  "protein": Number (grams),
  "fat": Number (grams)
}`;

                    try {
                        let aiReply = await generateWithFallback("Generate the macro protocol.", systemPrompt, []);
                        // Extract JSON between the first { and last } to avoid markdown formatting issues
                        const firstBrace = aiReply.indexOf('{');
                        const lastBrace = aiReply.lastIndexOf('}');
                        if (firstBrace !== -1 && lastBrace !== -1) {
                            aiReply = aiReply.substring(firstBrace, lastBrace + 1);
                        }

                        const protocol = JSON.parse(aiReply);

                        // Cache the result
                        db.run(`INSERT OR REPLACE INTO nutrition_protocols (user_id, date, protocol_json) VALUES (?, ?, ?)`,
                            [req.user.id, todayStr, JSON.stringify(protocol)]);

                        res.json(protocol);
                    } catch (e) {
                        console.error("Nutrition AI failed:", e);
                        // Fallback to a safe baseline if AI fails to parse
                        res.json({
                            title: "Balanced Maintenance",
                            rationale: "AI is currently resting. Here is a balanced baseline protocol for your weight.",
                            carbs: Math.round(weight * 4),
                            protein: Math.round(weight * 1.8),
                            fat: Math.round(weight * 1)
                        });
                    }
                });
            });
        });
    });
});

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

async function processTokenRefresh(refreshToken, internalUserId, resolve, reject) {
    try {
        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });

        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
            resolve({ accessToken: tokenData.access_token, internalUserId: internalUserId });
        } else {
            reject("Strava token refresh failed during API payload exchange.");
        }
    } catch (e) { reject(e); }
}

async function getStravaTokenForUser(userIdOrStravaId) {
    return new Promise((resolve, reject) => {
        const lookupVal = String(userIdOrStravaId).trim();

        db.get(`
            SELECT u.strava_refresh_token, u.id 
            FROM users u
            LEFT JOIN strava_tokens t ON u.id = t.user_id
            WHERE u.id = ? OR t.strava_id = ? OR CAST(t.strava_id AS TEXT) = ?
        `, [userIdOrStravaId, lookupVal, lookupVal], async (err, user) => {

            if (err || !user || !user.strava_refresh_token) {
                console.log(`⚠️ Mapping index missing for ${lookupVal}. Attempting profile fallback link...`);

                db.get(`SELECT id, strava_refresh_token FROM users WHERE strava_refresh_token IS NOT NULL LIMIT 1`, [], async (fallbackErr, fallbackUser) => {
                    if (fallbackErr || !fallbackUser || !fallbackUser.strava_refresh_token) {
                        return reject("No Strava token found anywhere in the system for identifier: " + userIdOrStravaId);
                    }

                    db.run(`INSERT OR IGNORE INTO strava_tokens (user_id, access_token, refresh_token, expires_at, strava_id) VALUES (?, ?, ?, ?, ?)`,
                        [fallbackUser.id, 'temporary', fallbackUser.strava_refresh_token, 0, lookupVal], (insertErr) => {
                            if (!insertErr) console.log(`✨ Successfully healed missing index mapping for Strava ID: ${lookupVal}`);
                        });

                    processTokenRefresh(fallbackUser.strava_refresh_token, fallbackUser.id, resolve, reject);
                });
            } else {
                processTokenRefresh(user.strava_refresh_token, user.id, resolve, reject);
            }
        });
    });
}

function calculateSparkScore(movingTimeMin, avgHr) {
    if (!movingTimeMin) return 0;
    let baseScore = movingTimeMin;
    let bonus = 0;

    if (avgHr) {
        if (avgHr >= 180) bonus = 0.40;
        else if (avgHr >= 160) bonus = 0.30;
        else if (avgHr >= 140) bonus = 0.20;
        else if (avgHr >= 120) bonus = 0.10;
    }

    return baseScore + (baseScore * bonus);
}

function mapStravaSportToSpark(stravaSport) {
    if (!stravaSport) return 'Other';
    if (stravaSport.includes('Run')) return 'Run';
    if (stravaSport.includes('Ride') || stravaSport.includes('VirtualRide')) return 'Bike';
    if (stravaSport.includes('Swim')) return 'Swim';
    if (stravaSport.includes('WeightTraining') || stravaSport.includes('Workout')) return 'Strength';
    return 'Other';
}

function formatStepsForStrava(stepsJson) {
    if (!stepsJson || stepsJson === '[]' || stepsJson === 'null') return null;
    try {
        const steps = JSON.parse(stepsJson);
        if (!steps || steps.length === 0) return null;
        let output = "";
        steps.forEach(s => {
            if (s.type === 'repeat') {
                output += `- Repeat ${s.iterations}x:\n`;
                if (s.steps) {
                    s.steps.forEach(sub => {
                        let dur = sub.condition_value + (sub.condition_type === 'time' ? ' min' : (sub.condition_type === 'distance' ? 'm' : ' reps'));
                        let tgt = sub.target_value ? sub.target_value : (sub.zone ? `Zone ${sub.zone}` : (sub.target_type === 'no.target' ? 'Open' : sub.target_type.replace('.zone', '')));
                        let extra = sub.weight ? ` @ ${sub.weight}kg` : (sub.target_type !== 'no.target' ? ` @ ${tgt}` : '');
                        let name = sub.exerciseName || sub.type;
                        output += `    * ${name}: ${dur}${extra}\n`;
                    });
                }
            } else {
                let dur = s.condition_value + (s.condition_type === 'time' ? ' min' : (s.condition_type === 'distance' ? 'm' : ' reps'));
                let tgt = s.target_value ? s.target_value : (s.zone ? `Zone ${s.zone}` : (s.target_type === 'no.target' ? 'Open' : s.target_type.replace('.zone', '')));
                let extra = s.weight ? ` @ ${s.weight}kg` : (s.target_type !== 'no.target' ? ` @ ${tgt}` : '');
                let name = s.exerciseName || s.type;
                output += `- ${name}: ${dur}${extra}\n`;
            }
        });
        return output.trim();
    } catch (e) {
        return null;
    }
}

async function tagStravaActivity(userId, activity, token) {
    if (activity.description && activity.description.includes("Spark Target")) return;

    db.get("SELECT value FROM athlete_metrics WHERE user_id = ? AND metric = 'strava_opt_out_activities'", [userId], (err, optOutRow) => {
        let optOutList = [];
        if (optOutRow && optOutRow.value) {
            try { optOutList = JSON.parse(optOutRow.value); } catch (e) { }
        }

        const activityType = activity.sport_type || activity.type;
        if (optOutList.includes(activityType)) {
            console.log(`🚫 Skipping Strava tag for ${activityType} activity ${activity.id} due to user opt-out.`);
            return;
        }

        const tss = activity.suffer_score || Math.round((activity.moving_time / 3600) * 50);
        const activityDate = activity.start_date_local ? activity.start_date_local.split('T')[0] : activity.start_date.split('T')[0];
        const sparkSport = mapStravaSportToSpark(activity.sport_type || activity.type);

        db.get("SELECT description, target_spark, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?",
            [userId, activityDate, sparkSport], async (err, plan) => {

                if (err || !plan) return;

                let stepsContent = formatStepsForStrava(plan.steps_json);
                const workoutContent = stepsContent ? stepsContent : ((plan.details && plan.details.trim().length > 0) ? plan.details : plan.description);

                const newDescription = `Spark Target: ${plan.target_spark} Spark\nActual: ${Math.round(tss)} Spark\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;

                const finalDescription = activity.description ? `${activity.description}\n\n---\n${newDescription}` : newDescription;

                try {
                    const updateRes = await fetch(`https://www.strava.com/api/v3/activities/${activity.id}`, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ description: finalDescription })
                    });
                    if (updateRes.ok) console.log(`✅ Strava description updated for ${sparkSport} on ${activityDate}`);
                } catch (e) {
                    console.error("Failed to tag Strava activity:", e);
                }
            });
    });
}

async function getStravaActivity(stravaAthleteId, activityId) {
    try {
        console.log(`🔍 Processing webhook activity ${activityId} for Strava Athlete ${stravaAthleteId}...`);

        let accessToken;
        let internalUserId;

        try {
            const result = await getStravaTokenForUser(stravaAthleteId);
            accessToken = result.accessToken;
            internalUserId = result.internalUserId;
        } catch (lookupError) {
            console.warn(`⚠️ Token mapping failed (${lookupError.message}). Aborting webhook processing.`);
            return;
        }

        const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await res.json();

        if (!data.id) {
            console.error("❌ Failed to pull activity details from Strava payload:", data);
            return;
        }

        const tss = data.suffer_score || Math.round((data.moving_time / 3600) * 50);
        const sparkScore = calculateSparkScore(data.moving_time / 60, data.average_heartrate);

        db.run(`INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss, spark_score) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET tss=excluded.tss, spark_score=excluded.spark_score, moving_time_min=excluded.moving_time_min, average_heartrate=excluded.average_heartrate`,
            [data.id, internalUserId, data.name, data.sport_type, data.distance / 1000, data.total_elevation_gain, data.moving_time / 60, data.average_heartrate || null, data.start_date, tss, sparkScore], (err) => {
                if (!err) {
                    sendSSEEvent(internalUserId, 'sync_complete', { provider: 'strava', activityId: data.id });

                    // Invalidate today's nutrition cache so it incorporates the new workout
                    const activityDateStr = data.start_date_local ? data.start_date_local.split('T')[0] : data.start_date.split('T')[0];
                    const todayStr = new Date().toISOString().split('T')[0];
                    if (activityDateStr === todayStr) {
                        db.run(`DELETE FROM nutrition_protocols WHERE user_id = ? AND date = ?`, [internalUserId, todayStr]);
                    }
                }
            });

        const activityDate = data.start_date_local ? data.start_date_local.split('T')[0] : data.start_date.split('T')[0];
        const sparkSport = mapStravaSportToSpark(data.sport_type);

        db.get("SELECT value FROM athlete_metrics WHERE user_id = ? AND metric = 'strava_opt_out_activities'", [internalUserId], (err, optOutRow) => {
            let optOutList = [];
            if (optOutRow && optOutRow.value) {
                try { optOutList = JSON.parse(optOutRow.value); } catch (e) { }
            }

            if (optOutList.includes(data.sport_type)) {
                console.log(`🚫 Skipping AI automation and Strava update for ${data.sport_type} activity ${activityId} due to user opt-out.`);
                return;
            }

            db.get("SELECT description, target_spark, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?",
                [internalUserId, activityDate, sparkSport], async (err, plan) => {

                    // Fetch the coach tone
                    db.get("SELECT coach_tone FROM users WHERE id = ?", [internalUserId], async (err, userRow) => {
                        const tone = userRow ? userRow.coach_tone : 'Friendly and motivating';

                        let prompt = `The user just completed a ${sparkSport} activity: ${data.name}. They covered ${(data.distance / 1000).toFixed(1)}km in ${Math.round(data.moving_time / 60)} minutes, generating ${Math.round(sparkScore)} Spark. `;
                        let newDescription = null;

                        if (plan) {
                            let stepsContent = formatStepsForStrava(plan.steps_json);
                            const workoutContent = stepsContent ? stepsContent : ((plan.details && plan.details.trim().length > 0) ? plan.details : plan.description);
                            newDescription = `Spark Target: ${plan.target_spark} Spark\nActual: ${Math.round(sparkScore)} Spark\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;
                            prompt += `The planned workout for today was: "${workoutContent}" with a target of ${plan.target_spark} Spark. Give a short, 1-2 sentence coach reaction based on your persona tone (${tone}). Praise them if they hit the target or give constructive advice if they missed it.`;
                        } else {
                            console.log(`⚠️ No matching ${sparkSport} plan found on ${activityDate}. Generating unplanned reaction.`);
                            prompt += `This was an unplanned activity. Give a short, 1-2 sentence coach reaction based on your persona tone (${tone}).`;
                        }

                        // 1. Generate AI Coach Response
                        try {
                            const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${tone}. Act like a real human in a continuous text message thread.`;
                            const aiReply = await generateWithFallback(prompt, systemPrompt);
                            db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`, [internalUserId, aiReply]);
                            sendSSEEvent(internalUserId, 'unread_message', { message: aiReply, mood: 'hype' });
                            console.log(`🤖 Sent proactive coach update for activity ${activityId}`);
                        } catch (e) {
                            console.error("Proactive coach activity update failed:", e);
                        }

                        // 2. Update Strava Description (only if there was a plan)
                        if (newDescription) {
                            const updateRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
                                method: 'PUT',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ description: newDescription })
                            });

                            if (updateRes.ok) {
                                console.log(`✅ Strava description updated for activity ${activityId}!`);
                            } else {
                                const errorData = await updateRes.json();
                                console.error(`❌ Strava Description Update Failed:`, errorData);
                            }
                        }
                    });
                });
        });

    } catch (e) {
        console.error(`❌ Fatal Webhook Processing Error for Strava Athlete ${stravaAthleteId}:`, e);
    }
}

async function syncAllStravaUsersOnStartup() {
    const SYNC_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown
    
    db.get(`SELECT value FROM system_state WHERE key = 'last_strava_sync_time'`, [], (err, row) => {
        if (!err && row && row.value) {
            const lastSync = parseInt(row.value, 10);
            if (Date.now() - lastSync < SYNC_COOLDOWN_MS) {
                console.log('⏳ Skipping initial Strava sync to respect rate limits (ran less than 1 hour ago).');
                return;
            }
        }
        
        db.run(`INSERT OR REPLACE INTO system_state (key, value, last_updated) VALUES ('last_strava_sync_time', ?, datetime('now'))`, [Date.now().toString()]);
        
        console.log('🔄 Running initial Strava sync for all connected users...');
        db.all('SELECT id FROM users WHERE strava_refresh_token IS NOT NULL', [], async (err, users) => {
            if (err || !users) return;

        for (const user of users) {
            try {
                const result = await getStravaTokenForUser(user.id);
                const token = result.accessToken;

                const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=50', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!actRes.ok) {
                    console.error(`❌ Strava Sync API Error ${actRes.status} for user ${user.id}`);
                    continue;
                }

                const activities = await actRes.json();

                if (Array.isArray(activities)) {
                    activities.forEach(act => {
                        const tss = act.suffer_score || Math.round((act.moving_time / 3600) * 50);
                        db.run(
                            `INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [act.id, user.id, act.name, act.sport_type, act.distance / 1000, act.total_elevation_gain, act.moving_time / 60, act.average_heartrate || 0, act.start_date, tss]
                        );
                    });
                    console.log(`✅ Startup sync complete for user ${user.id}`);
                } else {
                    console.error(`❌ Startup sync failed for user ${user.id}: Response is not an array`);
                }
            } catch (err) {
                console.error(`❌ Startup sync failed for user ${user.id}:`, err);
            }
        }
    });
    });
}

// --- SOCIAL ENDPOINTS ---

app.post('/api/settings/privacy', authenticateToken, (req, res) => {
    const { searchPrivacy } = req.body;
    db.run(`UPDATE users SET search_privacy = ? WHERE id = ?`, [searchPrivacy ? 1 : 0, req.user.id], function (err) {
        if (err) return res.status(500).json({ error: 'DB_ERROR' });
        res.json({ success: true });
    });
});

app.post('/api/settings/profile-picture', authenticateToken, uploadProfile.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const url = `/uploads/profiles/${req.file.filename}`;

    db.run(`UPDATE users SET profile_picture_url = ? WHERE id = ?`, [url, req.user.id], function (err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'DB_ERROR' });
        }
        res.json({ success: true, url });
    });
});

app.post('/api/social/search', authenticateToken, (req, res) => {
    const { username } = req.body;
    db.get(`SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND id != ? AND search_privacy = 0`, [username, req.user.id], (err, user) => {
        if (err || !user) return res.json({ found: false });
        db.get(`SELECT status FROM connections WHERE user_id = ? AND friend_id = ?`, [req.user.id, user.id], (err, conn) => {
            res.json({ found: true, user: { id: user.id, username: user.username, status: conn ? conn.status : null } });
        });
    });
});

app.post('/api/social/connect', authenticateToken, (req, res) => {
    const { friendId } = req.body;
    db.run(`INSERT OR IGNORE INTO connections (user_id, friend_id, status) VALUES (?, ?, 'pending')`, [req.user.id, friendId], function (err) {
        db.run(`INSERT OR IGNORE INTO connections (user_id, friend_id, status) VALUES (?, ?, 'pending_received')`, [friendId, req.user.id], function (err2) {
            sendSSEEvent(friendId, 'connection_request', { fromUserId: req.user.id, username: req.user.username });
            res.json({ success: true });
        });
    });
});

app.post('/api/social/accept', authenticateToken, (req, res) => {
    const { friendId } = req.body;
    db.run(`UPDATE connections SET status = 'accepted' WHERE user_id = ? AND friend_id = ?`, [req.user.id, friendId], function (err) {
        db.run(`UPDATE connections SET status = 'accepted' WHERE user_id = ? AND friend_id = ?`, [friendId, req.user.id], function (err2) {
            sendSSEEvent(friendId, 'connection_accepted', { fromUserId: req.user.id, username: req.user.username });

            db.get(`SELECT coach_tone FROM users WHERE id = ?`, [friendId], async (err, friendUser) => {
                if (friendUser) {
                    const prompt = `The athlete just connected with their friend ${req.user.username} on the app. Send a very short 1-sentence message to the athlete welcoming the new connection and telling them to use the competition as motivation.`;
                    const sysPrompt = `You are an elite endurance coach. Your tone is: ${friendUser.coach_tone || 'Friendly and motivating'}.`;
                    try {
                        const msg = await generateWithFallback(prompt, sysPrompt);
                        db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`, [friendId, msg]);
                        sendSSEEvent(friendId, 'unread_message', { message: msg, mood: 'support' });
                    } catch (e) { console.error(e); }
                }
            });

            res.json({ success: true });
        });
    });
});

app.get('/api/social/connections', authenticateToken, (req, res) => {
    db.all(`
        SELECT c.friend_id, c.status, u.username
        FROM connections c
        JOIN users u ON c.friend_id = u.id
        WHERE c.user_id = ?
    `, [req.user.id], (err, rows) => {
        res.json({ connections: rows || [] });
    });
});

app.get('/api/social/feed', authenticateToken, (req, res) => {
    db.all(`
        SELECT a.*, u.username, u.profile_picture_url, 
               (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id) as kudos_count,
               (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id AND k.user_id = ?) as has_kudosed
        FROM activities a
        JOIN users u ON a.user_id = u.id
        WHERE a.user_id = ? OR a.user_id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted')
        ORDER BY a.start_date DESC
        LIMIT 20
    `, [req.user.id, req.user.id, req.user.id], (err, rows) => {
        res.json({ activities: rows || [] });
    });
});

app.get('/api/social/leaderboard', authenticateToken, (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.profile_picture_url, SUM(a.tss) as total_spark_score, SUM(a.moving_time_min) as total_minutes, COUNT(a.id) as total_activities
        FROM activities a
        JOIN users u ON a.user_id = u.id
        WHERE (a.user_id = ? OR a.user_id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
          AND a.start_date >= datetime('now', '-7 days')
        GROUP BY u.id
        ORDER BY total_spark_score DESC
    `, [req.user.id, req.user.id], (err, rows) => {
        res.json({ leaderboard: rows || [] });
    });
});

app.post('/api/social/kudos', authenticateToken, (req, res) => {
    const { activityId } = req.body;
    db.get(`SELECT user_id FROM kudos WHERE activity_id = ? AND user_id = ?`, [activityId, req.user.id], (err, row) => {
        if (row) {
            db.run(`DELETE FROM kudos WHERE activity_id = ? AND user_id = ?`, [activityId, req.user.id], () => res.json({ success: true, added: false }));
        } else {
            db.run(`INSERT INTO kudos (activity_id, user_id) VALUES (?, ?)`, [activityId, req.user.id], () => {
                db.get(`SELECT user_id, name FROM activities WHERE id = ?`, [activityId], (err, act) => {
                    if (act && act.user_id !== req.user.id) {
                        sendSSEEvent(act.user_id, 'kudos_received', { activityName: act.name, fromUsername: req.user.username || 'Someone' });

                        db.get(`SELECT coach_tone FROM users WHERE id = ?`, [act.user_id], async (err, coachUser) => {
                            if (coachUser) {
                                const prompt = `The athlete just received Kudos (a like) from their friend ${req.user.username || 'Someone'} on their activity "${act.name}". Send a very short 1-sentence message to the athlete acknowledging this and hyping them up.`;
                                const sysPrompt = `You are an elite endurance coach. Your tone is: ${coachUser.coach_tone || 'Friendly and motivating'}.`;
                                try {
                                    const msg = await generateWithFallback(prompt, sysPrompt);
                                    db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`, [act.user_id, msg]);
                                    sendSSEEvent(act.user_id, 'unread_message', { message: msg, mood: 'hype' });
                                } catch (e) { console.error(e); }
                            }
                        });
                    }
                });
                res.json({ success: true, added: true });
            });
        }
    });
});

async function triggerBackgroundSummary(userId) {
    console.log(`🤖 Triggering background rolling summary for user ${userId}...`);

    db.get(`SELECT long_term_memory, coach_tone FROM users WHERE id = ?`, [userId], async (err, user) => {
        if (err || !user) return;

        db.all(`SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 10) ORDER BY id ASC`, [userId], async (err, historyRows) => {
            if (err || !historyRows || historyRows.length === 0) return;

            const historyText = historyRows.map(r => `${r.role.toUpperCase()}: ${r.content}`).join('\n');
            const currentSummary = user.long_term_memory || 'No summary yet.';

            const prompt = `You are a background AI assistant for an endurance coach app. Your job is to update the athlete's long-term memory summary based on recent chat history.
            
CURRENT LONG-TERM MEMORY:
${currentSummary}

RECENT CHAT HISTORY:
${historyText}

INSTRUCTIONS:
Update the long-term memory summary to incorporate any new important facts (injuries, new goals, shifts in mood, new baseline numbers). 
Keep it extremely concise (under 150 words). Do not include pleasantries. Only output the new summary text.`;

            try {
                const newSummary = await generateWithFallback(prompt);
                db.run(`UPDATE users SET long_term_memory = ? WHERE id = ?`, [newSummary.trim(), userId]);
                console.log(`✅ Updated long-term memory for user ${userId}`);
            } catch (e) {
                console.error(`❌ Failed to update long-term memory for user ${userId}:`, e);
            }
        });
    });
}

app.listen(process.env.PORT || 3001, () => {
    console.log('🚀 Spark HQ Multi-Tenant Engine live on port 3001...');
    syncAllStravaUsersOnStartup();
});