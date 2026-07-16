const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './nana_multi.db';
const db = new sqlite3.Database(DB_PATH);

const OLD_DIR = path.join(__dirname, 'public/uploads/physique');
const NEW_DIR = path.join(__dirname, 'secure_uploads/physique');

// Ensure the new directory exists
if (!fs.existsSync(NEW_DIR)) {
    fs.mkdirSync(NEW_DIR, { recursive: true });
}

console.log(`Starting image migration on database: ${DB_PATH}`);

db.all(`SELECT id, user_id, photo_url FROM physique_logs WHERE photo_url LIKE '/uploads/physique/%'`, [], (err, rows) => {
    if (err) {
        console.error("Database error:", err);
        return;
    }

    if (!rows || rows.length === 0) {
        console.log("No legacy images found that need migration.");
        return;
    }

    console.log(`Found ${rows.length} legacy images to migrate.`);

    let successCount = 0;
    let failCount = 0;

    rows.forEach(row => {
        // Old photo url: /uploads/physique/171283812.jpg
        const oldFilename = row.photo_url.split('/').pop();
        const oldFilePath = path.join(OLD_DIR, oldFilename);
        
        const ext = path.extname(oldFilename);
        const newFilename = `physique_${row.user_id}_${crypto.randomUUID()}${ext}`;
        const newFilePath = path.join(NEW_DIR, newFilename);
        const newPhotoUrl = `/api/images/physique/${newFilename}`;

        if (fs.existsSync(oldFilePath)) {
            try {
                // Move file
                fs.renameSync(oldFilePath, newFilePath);
                
                // Update DB
                db.run(`UPDATE physique_logs SET photo_url = ? WHERE id = ?`, [newPhotoUrl, row.id], (updateErr) => {
                    if (updateErr) {
                        console.error(`❌ Failed to update DB for log ID ${row.id}:`, updateErr);
                        failCount++;
                    } else {
                        console.log(`✅ Migrated: User ${row.user_id} | ${oldFilename} -> ${newFilename}`);
                        successCount++;
                    }
                });
            } catch (moveErr) {
                console.error(`❌ Failed to move file ${oldFilePath}:`, moveErr);
                failCount++;
            }
        } else {
            console.error(`⚠️ File not found on disk: ${oldFilePath}`);
            failCount++;
        }
    });

    // Simple delay to allow DB callbacks to finish before exiting (in a real app we'd use promises)
    setTimeout(() => {
        console.log(`\nMigration Complete!`);
        console.log(`Successfully migrated: ${successCount}`);
        console.log(`Failed/Missing: ${failCount}`);
        db.close();
    }, 2000);
});
