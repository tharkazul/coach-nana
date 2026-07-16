require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_multi.db');

db.get("SELECT strava_access_token FROM users WHERE id = 9", async (err, row) => {
    if (err || !row) {
        console.error("No token found in users table for id 9");
        return;
    }
    const token = row.strava_access_token;
    console.log("Got token from users table!");
    try {
        const res = await fetch('https://www.strava.com/api/v3/activities/19327955092', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const fs = require('fs');
        fs.writeFileSync('strava_activity_19327955092.json', JSON.stringify(data, null, 2));
        console.log("Saved to strava_activity_19327955092.json");
    } catch (e) {
        console.error(e);
    }
});
