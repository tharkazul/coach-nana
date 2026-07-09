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
const fs = require('fs');
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
const upload = multer({ dest: 'uploads/' });
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
const IV_LENGTH = 16; // For AES, this is always 16 bytes

// Optional but recommended: Serve the uploads folder so you (the admin) can view the images later
app.use('/uploads', express.static('uploads'));
app.use(bodyParser.json({ limit: '15mb' }));
app.use(express.static('public'));

const physiqueStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/uploads/physique');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext);
    }
});
const uploadPhysique = multer({ storage: physiqueStorage });

// Image Cleanup Routine (Every Hour)
setInterval(() => {
    const dir = path.join(__dirname, 'public/uploads/chat_images');
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
            const prompt = `The user has not logged any activities or sent any messages in over 24 hours. Write a short, proactive message checking in on them and asking how their training is going. Use the tone: ${user.coach_tone || 'Friendly and motivating'}. Keep it under 2 sentences.`;

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
        const prompt = `The user has not logged any activities or sent any messages in over 24 hours. Write a short, proactive message checking in on them and asking how their training is going. Use the tone: ${row ? row.coach_tone : 'Friendly and motivating'}. Keep it under 2 sentences.`;
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

async function generateWithFallback(prompt, systemInstruction = null, chatHistory = null, imageBase64 = null) {
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
    db.run(`CREATE TABLE IF NOT EXISTS micro_plan (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_tss REAL, details TEXT, steps_json TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`);
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
    'lap.button': { id: 1, key: "lap.button" },
    'reps': { id: 4, key: "reps" }
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

    // Remove client when connection closes
    req.on('close', () => {
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
                const fileName = `img_${req.user.id}_${Date.now()}.${ext}`;
                const savePath = path.join(__dirname, 'public/uploads/chat_images', fileName);
                fs.writeFileSync(savePath, base64Data, 'base64');
                imagePathDB = `/uploads/chat_images/${fileName}`;
            }
        } catch (e) {
            console.error("Image saving error:", e);
        }
    }

    db.get(`SELECT coach_tone, athlete_context, training_phase FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Failed to load athlete context." });

        db.all(`SELECT metric, value FROM athlete_metrics WHERE user_id = ?`, [req.user.id], async (err, metricsRows) => {
            const metricsText = (metricsRows && metricsRows.length > 0)
                ? metricsRows.map(m => `${m.metric}: ${m.value}`).join(', ')
                : 'None explicitly recorded yet.';

            const phase = await getUserMacroPhase(req.user.id);
            try {
                db.all(`SELECT name, sport_type, distance_km, moving_time_min, tss, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`, [req.user.id], async (err, recentActivities) => {
                    const recentActivitiesText = (recentActivities && recentActivities.length > 0)
                        ? recentActivities.map(a => `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${a.tss} TSS`).join('\n                    ')
                        : 'No recent activities recorded.';

                    db.all(`SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC`, [req.user.id], async (err, historyRows) => {

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

                        const systemPrompt =
                            `You are Spark, an elite Ironman Triathlon and endurance coach. 
                    Today is ${todayStr}.
                    Upcoming Calendar Reference: ${next7Days}
                    Athlete Context: ${user.athlete_context || 'General endurance athlete'}
                    Key Physiological Metrics: ${metricsText}
                    Current Macro Phase: ${phase}
                    Recent Completed Workouts (Last 3):
                    ${recentActivitiesText}
                    Your Tone & Persona: ${user.coach_tone || 'empathetic'}

                    MACRO BLOCK FOCUS RULES:
                    - If phase is BASE: Focus intensely on keeping their volume high and heart rate low (Zone 2). Discourage speedwork.
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
                    8. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Between sets, use a "recovery" step with "condition_type": "time". Reference the Athlete Context for their past weights, and try to prescribe slight progressive overload (e.g., +2.5kg).
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
                        "target_tss": 80,
                        "details": "Push hard on the intervals, recover fully on the rests.",
                        "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
                      },
                      {
                        "date": "YYYY-MM-DD",
                        "sport": "Strength", 
                        "description": "Leg Day Burner",
                        "target_tss": 40,
                        "details": "Focus on depth and explosion.",
                        "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 5, \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"repeat\\", \\"iterations\\": 3, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"reps\\", \\"condition_value\\": 10, \\"weight\\": 80, \\"exerciseName\\": \\"Barbell Squat\\", \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 2, \\"target_type\\": \\"no.target\\"}]}]"
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
                        "Cycling FTP": "250W",
                        "5K Run PB": "19:30",
                        "Squat Weight": "80kg"
                      }
                    }
                    \`\`\`

                    ACTIVITY LOGGING (CRITICAL):
                    If the athlete mentions they just completed a workout/activity that is NOT on Strava (e.g., "I just hit the gym", "I went for a 30 min run"), you MUST output an additional JSON block at the very end of your response to log it. Estimate the TSS (Training Stress Score) based on duration and intensity (e.g. 1 hour all out = 100 TSS, 1 hour easy = 50 TSS, 30 min weights = 25 TSS). Format it EXACTLY like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "log_activity",
                      "data": {
                        "name": "Gym Workout",
                        "sport_type": "Strength",
                        "distance_km": 0,
                        "moving_time_min": 30,
                        "tss": 25
                      }
                    }
                    \`\`\``;

                        let aiReply = await generateWithFallback(message, systemPrompt, cleanHistory, base64Data);
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
                                        INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) 
                                        VALUES (?, ?, ?, ?, ?, ?, ?)
                                    `);

                                            planData.forEach(day => {
                                                stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
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
                                        `INSERT INTO activities (id, user_id, name, sport_type, distance_km, moving_time_min, start_date, tss) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [manualId, req.user.id, act.name || 'Manual Workout', act.sport_type || 'Workout', act.distance_km || 0, act.moving_time_min || 0, startDate, act.tss || 0],
                                        (err) => {
                                            if (err) console.error("Failed to insert manual activity:", err);
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

                        res.json({ reply: aiReply, mood: mood, planUpdated: planUpdated });
                    });
                });
            } catch (e) {
                console.error("Chat Server Error:", e);
                res.status(500).json({ error: "AI failed to respond." });
            }
        });
    });
});

app.get('/api/dashboard/briefing', authenticateToken, (req, res) => {
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

        db.all(`SELECT name, sport_type, distance_km, moving_time_min, tss, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`, [req.user.id], async (err, recentActivities) => {
            const recentActivitiesText = (recentActivities && recentActivities.length > 0)
                ? recentActivities.map(a => `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${a.tss} TSS`).join('\n')
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
2. Reference either a recent workout they crushed, an upcoming workout they have planned, or their current Macro Phase.
3. Keep it brief, extremely human, and supportive. 
4. DO NOT generate any JSON or workout plan updates. Just the greeting.
5. GENERATIVE REWARDS: You have the ability to generate images by outputting Markdown: \`![description of image](https://image.pollinations.ai/prompt/{URL-encoded-description}?width=800&height=400&nologo=true)\`. IF the athlete recently crushed a massive workout (e.g., high TSS) or you just want to motivate them, you MUST include a highly stylized, cinematic, conceptual reward image (e.g., a glowing golden running shoe, a heroic finish line, a futuristic bicycle). Put the image markdown at the END of your greeting.`;

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
        // But some might have been auto-added by the AI. It's safer to just clear and insert the passed array from the UI,
        // assuming the UI sent the complete list.
        db.run(`DELETE FROM athlete_metrics WHERE user_id = ?`, [req.user.id]);
        const stmt = db.prepare(`INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, ?, ?)`);
        metrics.forEach(m => {
            stmt.run(req.user.id, m.metric, m.value);
        });
        stmt.finalize();
        res.json({ message: "Metrics updated successfully!" });
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

app.get('/api/dashboard-data', authenticateToken, (req, res) => {
    db.all(`SELECT substr(start_date, 1, 10) as date, sport_type, SUM(tss) as daily_tss FROM activities WHERE user_id = ? GROUP BY date, sport_type ORDER BY date ASC`, [req.user.id], (err, rows) => {
        if (!rows) return res.json([]);
        const aggregated = {};
        rows.forEach(r => {
            const mappedSport = mapStravaSportToSpark(r.sport_type);
            const key = `${r.date}_${mappedSport}`;
            if (!aggregated[key]) aggregated[key] = { date: r.date, sport_type: mappedSport, daily_tss: 0 };
            aggregated[key].daily_tss += r.daily_tss;
        });
        res.json(Object.values(aggregated));
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
        `INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, date, sport, description, target_tss, details],
        (err) => {
            if (err) return res.status(500).json({ error: "Failed to update plan" });
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

        const stmt = db.prepare(`INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        workouts.forEach(w => {
            stmt.run(req.user.id, date, w.sport, w.description, w.target_tss, w.details, w.steps_json || '[]');
        });
        stmt.finalize();
        res.json({ success: true });
    });
});
app.put('/api/micro-plan/:id', authenticateToken, (req, res) => {
    const { sport, description, target_tss, details } = req.body;
    db.run(
        `UPDATE micro_plan SET sport = ?, description = ?, target_tss = ?, details = ? WHERE id = ? AND user_id = ?`,
        [sport, description, target_tss, details, req.params.id, req.user.id],
        (err) => {
            if (err) return res.status(500).json({ error: "Failed to update plan" });
            res.json({ success: true });
        }
    );
});

app.delete('/api/micro-plan/:id', authenticateToken, (req, res) => {
    db.run(`DELETE FROM micro_plan WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: "Failed to delete plan" });
        res.json({ success: true });
    });
});

app.post('/api/generate-plan', authenticateToken, async (req, res) => {
    const { targetDate } = req.body;

    db.get(`SELECT coach_tone, athlete_context, training_phase, current_ctl, current_atl FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: "Athlete context not found." });

        db.all(`SELECT metric, value FROM athlete_metrics WHERE user_id = ?`, [req.user.id], async (err, metricsRows) => {
            const metricsText = (metricsRows && metricsRows.length > 0)
                ? metricsRows.map(m => `${m.metric}: ${m.value}`).join(', ')
                : 'None explicitly recorded yet.';

            const systemPrompt = `You are Coach Spark, an elite Ironman Triathlon and endurance coach.
            Tone: ${user.coach_tone || 'empathetic'}
            Athlete Context: ${user.athlete_context || 'General endurance athlete'}
            Key Physiological Metrics: ${metricsText}
        
        CRITICAL RULES:
        1. You are generating a 7-day training plan starting exactly on ${targetDate}.
        2. You must append a JSON code block at the very end of your response containing the schedule.
        3. Use metric measurements exclusively (km, kg, km/h). DO NOT repeat greetings, filler words, or preamble.
        4. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout, create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
        5. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Between sets, use a "recovery" step with "condition_type": "time". Reference the Athlete Context for their past weights, and push for progressive overload.
        6. TARGETS: If a workout requires a specific pace (e.g. "4:15 min/km") or power (e.g. "250W") instead of a generic zone, add a "target_value" string to the step object (e.g., "target_value": "4:15 min/km"). Otherwise, continue using "zone": <number>.

        WORKOUT PLANNING (CRITICAL):
        If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
        The JSON must be a valid Array of objects. Format it EXACTLY JSON FORMAT REQUIRED AT THE END OF YOUR RESPONSE:
        \`\`\`json
        [
          {
            "date": "YYYY-MM-DD",
            "sport": "Run", 
            "description": "5k Speed Intervals",
            "target_tss": 80,
            "details": "Push hard on the intervals, recover fully on the rests.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
          },
          {
            "date": "YYYY-MM-DD",
            "sport": "Strength", 
            "description": "Leg Day Burner",
            "target_tss": 40,
            "details": "Focus on depth and explosion.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 5, \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"repeat\\", \\"iterations\\": 3, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"reps\\", \\"condition_value\\": 10, \\"weight\\": 80, \\"exerciseName\\": \\"Barbell Squat\\", \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 2, \\"target_type\\": \\"no.target\\"}]}]"
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
                                INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) 
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `);

                                planData.forEach(day => {
                                    stmt.run(req.user.id, day.date, day.sport, day.description, day.target_tss, day.details, day.steps_json || '[]');
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
        }); // End metrics fetch
    });
});

app.post('/api/feedback', authenticateToken, upload.single('feedbackImage'), (req, res) => {
    const feedbackText = req.body.text;
    const imagePath = req.file ? req.file.path : null;
    const createdAt = new Date().toISOString();

    if (!feedbackText) {
        return res.status(400).json({ error: "Feedback text is required." });
    }

    db.run(
        `INSERT INTO feedback (user_id, text, image_path, created_at) VALUES (?, ?, ?, ?)`,
        [req.user.id, feedbackText, imagePath, createdAt],
        function (err) {
            if (err) {
                console.error("Failed to save feedback:", err);
                return res.status(500).json({ error: "Failed to save feedback." });
            }
            res.json({ message: "Feedback received loud and clear! Thank you." });
        }
    );
});

app.get('/api/admin/usage', authenticateToken, (req, res) => {
    if (!req.user.username.toLowerCase().includes('rutger') && req.user.id !== 1) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    db.all(`SELECT username, login_count, chat_count FROM users ORDER BY login_count DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(rows || []);
    });
});

app.get('/api/admin/feedback', authenticateToken, (req, res) => {
    db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user || user.username.toLowerCase() !== 'rutger') {
            return res.status(403).json({ error: "Access denied. Admins only." });
        }

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
            db.all(`SELECT date, sport, description, target_tss, steps_json FROM micro_plan WHERE user_id = ? AND date >= ?`,
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
                let durationMins = Math.max(5, Math.round((workout.target_tss / 55) * 60));
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
                                if (subStep.target_value.includes('min/km')) {
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
                                sDTO.description = subStep.exerciseName;
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
                    if (step.target_value.includes('min/km')) {
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
                    stepDTO.description = step.exerciseName;
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

        res.json({ message: `Successfully pushed ${syncedCount} structured workouts!` });

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

app.post('/api/physique', authenticateToken, uploadPhysique.single('photo'), async (req, res) => {
    const { date, weight_kg, sleep_quality, fatigue_level, notes } = req.body;
    const photoUrl = req.file ? `/uploads/physique/${req.file.filename}` : null;
    
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
                
                db.all(`SELECT sport, description, target_tss FROM micro_plan WHERE user_id = ? AND date = ?`, [req.user.id, date], (err, planRows) => {
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
            
            db.all(`SELECT date, tss, description FROM micro_plan WHERE user_id = ? AND date >= date('now') LIMIT 1`, [req.user.id], async (err, todayPlan) => {
                const todayTSS = todayPlan && todayPlan.length > 0 ? todayPlan[0].tss : 0;
                const todayDesc = todayPlan && todayPlan.length > 0 ? todayPlan[0].description : 'Rest day';

                const systemPrompt = `You are an elite sports nutritionist. The user is an endurance athlete currently in their ${phase} phase.
Their latest weight is ${weight}kg.
Today's training plan: ${todayDesc} (TSS: ${todayTSS}).

Based on today's training load and their current macro phase, recommend a daily macro nutrition target.
- For high TSS / intense days, prescribe higher carbohydrates.
- For rest / low TSS days, prescribe lower carbohydrates and higher protein/fat.
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
                        let tgt = sub.target_value ? sub.target_value : (sub.zone ? `Zone ${sub.zone}` : (sub.target_type === 'no.target' ? 'Open' : sub.target_type.replace('.zone','')));
                        let extra = sub.weight ? ` @ ${sub.weight}kg` : (sub.target_type !== 'no.target' ? ` @ ${tgt}` : '');
                        let name = sub.exerciseName || sub.type;
                        output += `    * ${name}: ${dur}${extra}\n`;
                    });
                }
            } else {
                let dur = s.condition_value + (s.condition_type === 'time' ? ' min' : (s.condition_type === 'distance' ? 'm' : ' reps'));
                let tgt = s.target_value ? s.target_value : (s.zone ? `Zone ${s.zone}` : (s.target_type === 'no.target' ? 'Open' : s.target_type.replace('.zone','')));
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

    const tss = activity.suffer_score || Math.round((activity.moving_time / 3600) * 50);
    const activityDate = activity.start_date_local ? activity.start_date_local.split('T')[0] : activity.start_date.split('T')[0];
    const sparkSport = mapStravaSportToSpark(activity.sport_type || activity.type);

    db.get("SELECT description, target_tss, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?",
        [userId, activityDate, sparkSport], async (err, plan) => {

            if (err || !plan) return;

            let stepsContent = formatStepsForStrava(plan.steps_json);
            const workoutContent = stepsContent ? stepsContent : ((plan.details && plan.details.trim().length > 0) ? plan.details : plan.description);

            const newDescription = `Spark Target: ${plan.target_tss} TSS\nActual: ${tss} TSS\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;

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
            console.warn(`⚠️ Token mapping failed (${lookupError.message}). Using master fallback account...`);

            internalUserId = 1;
            const fallbackResult = await getStravaTokenForUser(internalUserId);
            accessToken = fallbackResult.accessToken;
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

        db.run(`INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET tss=excluded.tss`,
            [data.id, internalUserId, data.name, data.sport_type, data.distance / 1000, data.total_elevation_gain, data.moving_time / 60, data.average_heartrate || 0, data.start_date, tss], (err) => {
                if (!err) {
                    sendSSEEvent(internalUserId, 'sync_complete', { provider: 'strava', activityId: data.id });
                }
            });

        const activityDate = data.start_date_local ? data.start_date_local.split('T')[0] : data.start_date.split('T')[0];
        const sparkSport = mapStravaSportToSpark(data.sport_type);

        db.get("SELECT description, target_tss, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND sport = ?",
            [internalUserId, activityDate, sparkSport], async (err, plan) => {

                // Fetch the coach tone
                db.get("SELECT coach_tone FROM users WHERE id = ?", [internalUserId], async (err, userRow) => {
                    const tone = userRow ? userRow.coach_tone : 'Friendly and motivating';

                    let prompt = `The user just completed a ${sparkSport} activity: ${data.name}. They covered ${(data.distance / 1000).toFixed(1)}km in ${Math.round(data.moving_time / 60)} minutes, generating ${tss} TSS. `;
                    let newDescription = null;

                    if (plan) {
                        let stepsContent = formatStepsForStrava(plan.steps_json);
                        const workoutContent = stepsContent ? stepsContent : ((plan.details && plan.details.trim().length > 0) ? plan.details : plan.description);
                        newDescription = `Spark Target: ${plan.target_tss} TSS\nActual: ${tss} TSS\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;
                        prompt += `The planned workout for today was: "${workoutContent}" with a target of ${plan.target_tss} TSS. Give a short, 1-2 sentence coach reaction based on your persona tone (${tone}). Praise them if they hit the target or give constructive advice if they missed it.`;
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

    } catch (e) {
        console.error(`❌ Fatal Webhook Processing Error for Strava Athlete ${stravaAthleteId}:`, e);
    }
}

async function syncAllStravaUsersOnStartup() {
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

                const activities = await actRes.json();

                activities.forEach(act => {
                    const tss = act.suffer_score || Math.round((act.moving_time / 3600) * 50);
                    db.run(
                        `INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [act.id, user.id, act.name, act.sport_type, act.distance / 1000, act.total_elevation_gain, act.moving_time / 60, act.average_heartrate || 0, act.start_date, tss]
                    );

                    tagStravaActivity(user.id, act, token);
                });
                console.log(`✅ Startup sync complete for user ${user.id}`);
            } catch (err) {
                console.error(`❌ Startup sync failed for user ${user.id}:`, err);
            }
        }
    });
}

app.listen(process.env.PORT || 3001, () => {
    console.log('🚀 Spark HQ Multi-Tenant Engine live on port 3001...');
    syncAllStravaUsersOnStartup();
});