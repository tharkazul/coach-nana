const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Error connecting to database:", err);
        process.exit(1);
    }
});

const oldPhysiqueDir = path.join(__dirname, 'public/uploads/physique');
const newPhysiqueDir = path.join(__dirname, 'secure_uploads/physique');
const oldChatDir = path.join(__dirname, 'public/uploads/chat_images');
const newChatDir = path.join(__dirname, 'secure_uploads/chat_images');

// Ensure new directories exist
if (!fs.existsSync(newPhysiqueDir)) fs.mkdirSync(newPhysiqueDir, { recursive: true });
if (!fs.existsSync(newChatDir)) fs.mkdirSync(newChatDir, { recursive: true });

async function migratePhysiqueImages() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, user_id, photo_url FROM physique_logs WHERE photo_url LIKE '/uploads/physique/%'`, (err, rows) => {
            if (err) return reject(err);
            
            let processed = 0;
            if (rows.length === 0) return resolve();

            rows.forEach(row => {
                const oldFilename = row.photo_url.split('/').pop();
                const oldPath = path.join(oldPhysiqueDir, oldFilename);
                const ext = path.extname(oldFilename);
                const newFilename = `physique_${row.user_id}_${crypto.randomUUID()}${ext}`;
                const newPath = path.join(newPhysiqueDir, newFilename);
                const newUrl = `/api/images/physique/${newFilename}`;

                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                    db.run(`UPDATE physique_logs SET photo_url = ? WHERE id = ?`, [newUrl, row.id], (err) => {
                        if (err) console.error(`Error updating DB for physique log ${row.id}:`, err);
                        else console.log(`Migrated physique image for user ${row.user_id}: ${oldFilename} -> ${newFilename}`);
                        
                        processed++;
                        if (processed === rows.length) resolve();
                    });
                } else {
                    console.log(`File not found, skipping: ${oldPath}`);
                    processed++;
                    if (processed === rows.length) resolve();
                }
            });
        });
    });
}

async function migrateChatImages() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, user_id, image_path FROM chat_history WHERE image_path LIKE '/uploads/chat_images/%'`, (err, rows) => {
            if (err) return reject(err);
            
            let processed = 0;
            if (rows.length === 0) return resolve();

            rows.forEach(row => {
                const oldFilename = row.image_path.split('/').pop();
                const oldPath = path.join(oldChatDir, oldFilename);
                const ext = path.extname(oldFilename);
                
                // Ensure it has the prefix, or regenerate it
                let newFilename = oldFilename;
                if (!newFilename.startsWith(`img_${row.user_id}_`)) {
                    newFilename = `img_${row.user_id}_${crypto.randomUUID()}${ext}`;
                }

                const newPath = path.join(newChatDir, newFilename);
                const newUrl = `/api/images/chat/${newFilename}`;

                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                    db.run(`UPDATE chat_history SET image_path = ? WHERE id = ?`, [newUrl, row.id], (err) => {
                        if (err) console.error(`Error updating DB for chat msg ${row.id}:`, err);
                        else console.log(`Migrated chat image for user ${row.user_id}: ${oldFilename} -> ${newFilename}`);
                        
                        processed++;
                        if (processed === rows.length) resolve();
                    });
                } else {
                    console.log(`File not found, skipping: ${oldPath}`);
                    processed++;
                    if (processed === rows.length) resolve();
                }
            });
        });
    });
}

async function runMigration() {
    try {
        console.log("Starting image migration...");
        await migratePhysiqueImages();
        await migrateChatImages();
        console.log("Migration complete!");
    } catch (e) {
        console.error("Migration failed:", e);
    } finally {
        db.close();
    }
}

runMigration();
