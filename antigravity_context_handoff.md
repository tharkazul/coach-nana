# Antigravity Handoff & Context Document: Coach-Nana / Spark APP

This document contains a complete technical overview of the **Spark App** (`coach-nana`), including its architecture, database state, recent features built, environment configuration, and step-by-step instructions to seamlessly resume development.

---

## 1. Project Overview & Identity

- **Project Name:** Coach-Nana / Spark APP
- **GitHub Repository:** `tharkazul/coach-nana`
- **Primary Domain:** AI Coaching, Fitness & Recovery Tracking, Physique Metrics, Gamification & Leaderboards.
- **Tech Stack:**
  - **Backend:** Node.js (CommonJS), Express.js v5 (`express`), WebSockets (`ws`), Node-Cron (`node-cron`).
  - **Database:** SQLite 3 (`sqlite3` / `nana_multi.db`).
  - **AI Integration:** Google Gemini API (`@google/generative-ai`) with token tracking and multi-key fallback.
  - **Integrations:** Strava API REST + Webhooks, Garmin Connect (`@flow-js/garmin-connect`).
  - **Frontend:** Vanilla HTML5 / Modern CSS3 (Dark mode, glassmorphism, responsive micro-animations) + Vanilla JS (`script.js`). Progressive Web App (PWA) with Service Worker (`sw.js`).

---

## 2. Directory Structure & Architecture

```
/
├── server.js               # Entry point: Express server initialization, DB boot, cron jobs, middleware
├── package.json            # Node.js dependencies & scripts
├── .env                    # Environment variables (API keys, DB path, secrets)
├── nana_multi.db           # Main active SQLite database
├── routes/                 # Express API routes
│   ├── auth.js             # User login, registration, JWT handling
│   ├── chat.js             # AI chat endpoints, context window assembly, token limits
│   ├── activities.js       # Garmin & Strava workouts, manual activity logs
│   ├── physique.js         # Body weight, body fat %, physique photos
│   ├── gamification.js     # Leaderboards, user points, streaks, level progression
│   ├── integrations.js     # Strava OAuth & webhook sync, Garmin connections
│   ├── social.js           # Public user profiles, feed
│   ├── settings.js         # User preferences & account settings
│   └── admin.js            # Admin management endpoints
├── services/               # Core business logic & helpers
│   ├── db.js               # Database schema definition, SQLite connection & initialization
│   ├── ai.js               # Gemini API client setup, model generation, prompt formatting
│   ├── utils.js            # Fitness metrics, recovery calculations, morning message generator, token helpers
│   ├── auth.js             # JWT verification middleware
│   ├── crypto.js           # Password hashing & sensitive token encryption
│   └── sse.js              # Server-Sent Events broadcasting
└── public/                 # Web app static assets & client code
    ├── index.html          # Main single-page web app layout
    ├── index-new.html      # Mobile-optimized alternative / menu redesign testing layout
    ├── script.js           # Main client-side application logic (state, charts, DOM, SSE/WS)
    ├── sw.js               # PWA service worker caching
    └── admin-live.html     # Live administration dashboard
```

---

## 3. Core Features & Recent Work Accomplished

1. **Modular Monolith Refactoring:**
   - Successfully decoupled monolithic `server.old.js` into clean `routes/` and `services/` components.
2. **AI Fitness Coach (Gemini Integration):**
   - Implemented streaming and non-streaming Gemini API interactions in `services/ai.js` and `routes/chat.js`.
   - Consolidated token counting and context trimming logic into `services/utils.js` (`calculateTokenLimit`, context truncation).
   - Multi-key rotation support (`GEMINI_API_KEY`, `GEMINI_API_KEY2`) to prevent rate limit bottlenecks.
3. **Automated Cron Jobs & Recovery Tracking:**
   - **08:00 AM Europe/Amsterdam:** Automated daily morning nutrition and recovery messages sent via AI.
   - **00:05 AM Europe/Amsterdam:** Daily recovery calculations and stat degradation job (`runDailyRecoveryJob`).
   - **Bi-hourly:** Background sync for Strava activities across active users.
4. **UI/UX & Mobile Responsiveness:**
   - Centered and floating glassmorphic navbar with adjusted opacity.
   - Responsive progress dashboard, physique photo comparison slider, and workout logs.
   - PWA installation support via `manifest.json` and `sw.js`.
5. **Spark Calculator & Gamification:**
   - Custom fitness score calculator based on volume, intensity, and consistency.
   - Global leaderboards and automated profile updates (`generateAllPublicProfiles`).

---

## 4. Environment Setup & Configuration (.env)

When setting up on the new laptop, recreate `.env` in the root of the project with the following structure:

```env
PORT=3005
DB_PATH=./nana_multi.db
GEMINI_API_KEY=<YOUR_PRIMARY_GEMINI_API_KEY>
GEMINI_API_KEY2=<YOUR_SECONDARY_GEMINI_API_KEY>
STRAVA_CLIENT_ID=<STRAVA_CLIENT_ID>
STRAVA_CLIENT_SECRET=<STRAVA_CLIENT_SECRET>
STRAVA_REFRESH_TOKEN=<STRAVA_REFRESH_TOKEN>
JWT_SECRET=<JWT_SECRET_KEY>
ENCRYPTION_KEY=<32_CHARACTER_ENCRYPTION_KEY>
```

---

## 5. Migration Checklist for the New Laptop

### Step 1: Copy Codebase & Data Files
- Clone the repository: `git clone git@github.com:tharkazul/coach-nana.git`
- **Crucial Data Backup:** Copy `nana_multi.db` from the old laptop to the project root on the new laptop (this contains all user accounts, chat histories, activities, and physique logs).
- Copy `.env` to the project root.
- Ensure untracked secure uploads (`public/uploads/` and `routes/secure_uploads/`) are backed up if physique images are stored locally.

### Step 2: Install & Launch
```bash
cd spark
npm install
node server.js
```

### Step 3: Antigravity Context Briefing for New Laptop Instance
When launching Antigravity on the new laptop, give it the following prompt to prime its context immediately:

> "I am working on the Spark App (`coach-nana`), an AI-powered fitness and recovery coaching app built with Node.js, Express, SQLite, Vanilla JS (PWA), and Gemini AI. Please refer to `antigravity_context_handoff.md` for full architectural overview, database schema, and project rules."

---

## 6. Important Guidelines for Antigravity AI Pair Programming

1. **Backend Rules:**
   - Use Express v5 route standards.
   - Database operations use `sqlite3` asynchronously in `services/db.js` or via helpers in `services/utils.js`.
   - Never overwrite `nana_multi.db` structure without running table migrations.
2. **Frontend Rules:**
   - Preserve Vanilla JS (`public/script.js`) and Vanilla CSS styling. Do not introduce build bundlers or Tailwind unless explicitly requested.
   - Maintain dark mode aesthetic, vibrant accents, glassmorphic containers, and smooth micro-animations.
3. **Verification Protocol:**
   - Always test server startup (`node server.js`) and check for syntax or route mounting errors after editing backend files.
