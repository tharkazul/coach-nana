require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const dbPath = process.env.DB_PATH || './nana_multi.db'; // Adjust if you're using staging
const db = new sqlite3.Database(dbPath);

console.log(`Connecting to ${dbPath} to fix spark scores...`);

db.serialize(() => {
    // 1. First, make sure the column exists (it should, but just in case)
    db.run(`ALTER TABLE activities ADD COLUMN spark_score REAL`, (err) => {
        // Ignore error if column already exists
    });

    // 2. Update existing rows where spark_score is NULL or 0 but we have moving time
    const query = `
        UPDATE activities 
        SET spark_score = moving_time_min + (moving_time_min * 
            CASE 
                WHEN average_heartrate >= 180 THEN 0.40
                WHEN average_heartrate >= 160 THEN 0.30
                WHEN average_heartrate >= 140 THEN 0.20
                WHEN average_heartrate >= 120 THEN 0.10
                ELSE 0.0
            END
        )
        WHERE (spark_score IS NULL OR spark_score = 0) AND moving_time_min > 0;
    `;

    db.run(query, function(err) {
        if (err) {
            console.error("Error updating scores:", err.message);
        } else {
            console.log(`Success! Updated ${this.changes} activities with corrected spark scores.`);
        }
        db.close();
    });
});
