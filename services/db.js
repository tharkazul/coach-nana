const sqlite3 = require("sqlite3").verbose();
const dbPath = process.env.DB_PATH || "./nana_multi.db";
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
        profile_picture_url TEXT,
        common_token_usage INTEGER DEFAULT 0,
        daily_token_limit INTEGER DEFAULT 10000,
        subscription_tier TEXT DEFAULT 'free',
        spark_plus_clicks INTEGER DEFAULT 0
    )`);
  // Add columns if they don't exist (fails silently if they do)
  db.run(
    `ALTER TABLE users ADD COLUMN long_term_memory TEXT DEFAULT ''`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN daily_token_usage INTEGER DEFAULT 0`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN common_token_usage INTEGER DEFAULT 0`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN daily_token_limit INTEGER DEFAULT 50000`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN spark_plus_clicks INTEGER DEFAULT 0`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN last_token_reset_date TEXT`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN search_privacy INTEGER DEFAULT 0`,
    (err) => {},
  );
  db.run(`ALTER TABLE users ADD COLUMN profile_picture_url TEXT`, (err) => {});
  db.run(
    `ALTER TABLE users ADD COLUMN training_availability TEXT`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE users ADD COLUMN gender TEXT DEFAULT 'Prefer not to say'`,
    (err) => {},
  );
  db.run(`ALTER TABLE users ADD COLUMN last_cycle_start TEXT`, (err) => {});
  db.run(
    `ALTER TABLE users ADD COLUMN average_cycle_length INTEGER DEFAULT 28`,
    (err) => {},
  );
  db.run(`ALTER TABLE users ADD COLUMN total_spark REAL DEFAULT 0`, (err) => {
    if (!err) {
      console.log("Backfilling total_spark for all users...");
      db.all(
        `SELECT user_id, SUM(spark_score) as total FROM activities GROUP BY user_id`,
        (err, rows) => {
          if (!err && rows) {
            const stmt = db.prepare(
              `UPDATE users SET total_spark = ? WHERE id = ?`,
            );
            rows.forEach((r) => stmt.run(r.total || 0, r.user_id));
            stmt.finalize(() => console.log("total_spark backfill complete."));
          }
        },
      );
    }
  });
  db.run(`CREATE TABLE IF NOT EXISTS strava_tokens (
        user_id INTEGER PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        strava_id TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  db.run(
    `CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, sport_type TEXT, distance_km REAL, elevation_m INTEGER, moving_time_min REAL, average_heartrate REAL, start_date TEXT, tss REAL)`,
  );
  db.run(`ALTER TABLE activities ADD COLUMN spark_score REAL`, (err) => {
    // Automatically backfill any activities that have a NULL spark_score
    db.all(
      `SELECT id, moving_time_min, average_heartrate FROM activities WHERE spark_score IS NULL`,
      (err, rows) => {
        if (!err && rows && rows.length > 0) {
          console.log(
            `Backfilling spark_score for ${rows.length} activities...`,
          );
          const stmt = db.prepare(
            `UPDATE activities SET spark_score = ? WHERE id = ?`,
          );
          rows.forEach((row) => {
            let bonus = 0;
            if (row.average_heartrate) {
              if (row.average_heartrate >= 180) bonus = 0.4;
              else if (row.average_heartrate >= 160) bonus = 0.3;
              else if (row.average_heartrate >= 140) bonus = 0.2;
              else if (row.average_heartrate >= 120) bonus = 0.1;
            }
            const score =
              (row.moving_time_min || 0) + (row.moving_time_min || 0) * bonus;
            stmt.run(score, row.id);
          });
          stmt.finalize(() => console.log("Spark Score backfill complete."));
        }
      },
    );
  });
  db.run(`ALTER TABLE activities ADD COLUMN sets_json TEXT`, (err) => {
    if (!err) console.log("Added sets_json column to activities table.");
  });
  db.run(
    `CREATE TABLE IF NOT EXISTS micro_plan (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_spark REAL, details TEXT, steps_json TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`,
  );
  db.run(
    `ALTER TABLE micro_plan RENAME COLUMN target_tss TO target_spark`,
    (err) => {},
  );

  // Ensure steps_json exists for legacy DBs (if table has id but no steps_json)
  db.run(
    `ALTER TABLE micro_plan ADD COLUMN steps_json TEXT DEFAULT '[]'`,
    (err) => {
      if (err && !err.message.includes("duplicate column name")) {
        console.error("Error adding steps_json column:", err.message);
      }
    },
  );

  // Migration: check if micro_plan is missing the 'id' column. If so, rebuild it.
  // This also implicitly drops the legacy UNIQUE(user_id, date, sport) constraint so users can have 2 runs in a day.
  db.all(`PRAGMA table_info(micro_plan);`, (err, rows) => {
    if (!err && rows && rows.length > 0) {
      const hasId = rows.some((r) => r.name === "id");
      if (!hasId) {
        console.log(
          "Migrating micro_plan table to include id column and drop unique constraints...",
        );
        db.serialize(() => {
          db.run(
            `CREATE TABLE IF NOT EXISTS micro_plan_new (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, sport TEXT, description TEXT, target_spark REAL, details TEXT, steps_json TEXT, FOREIGN KEY(user_id) REFERENCES users(id))`,
          );
          db.run(
            `INSERT INTO micro_plan_new (user_id, date, sport, description, target_spark, details, steps_json) SELECT user_id, date, sport, description, target_tss as target_spark, details, steps_json FROM micro_plan`,
          );
          db.run(`DROP TABLE micro_plan`);
          db.run(`ALTER TABLE micro_plan_new RENAME TO micro_plan`);
        });
      }
    }
  });

  db.run(
    `CREATE TABLE IF NOT EXISTS weight_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, weight_kg REAL, body_fat_percent REAL, bmi REAL, lean_mass_kg REAL, UNIQUE(user_id, date))`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, role TEXT, content TEXT, mood TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS athlete_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, metric TEXT, value TEXT, UNIQUE(user_id, metric))`,
  );
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

  // Gamification tables
  db.run(`CREATE TABLE IF NOT EXISTS bonus_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        description TEXT,
        target_metric TEXT,
        target_value REAL,
        reward_points REAL,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

  db.run(
    `ALTER TABLE user_quests ADD COLUMN target_sport TEXT DEFAULT 'Any'`,
    (err) => {},
  );
  db.run(
    `ALTER TABLE user_quests ADD COLUMN is_accumulative INTEGER DEFAULT 0`,
    (err) => {},
  );

  db.run(`CREATE TABLE IF NOT EXISTS user_titles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS athlete_niggles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        body_part TEXT,
        severity INTEGER,
        notes TEXT,
        status TEXT,
        reported_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

  db.run(`ALTER TABLE athlete_niggles ADD COLUMN resolved_date DATETIME`, (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS athlete_fatigue_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        body_part TEXT,
        fatigue_score REAL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
});

module.exports = db;
