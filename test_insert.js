const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_multi.db');

const date = '2026-07-09';
const sport = 'Bike';
const description = 'test 2';
const target_tss = 15;
const details = '';
const steps_json = '[]';
const user_id = 1;

db.run(
    `INSERT INTO micro_plan (user_id, date, sport, description, target_tss, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user_id, date, sport, description, target_tss, details, steps_json || '[]'],
    function(err) {
        if (err) console.error("Error:", err.message);
        else console.log("Success, ID:", this.lastID);
    }
);
