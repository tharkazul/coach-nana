require('dotenv').config({ path: '../.env' });
const db = require('../services/db.js');
const { getStravaTokenForUser } = require('../services/utils.js');

const USER_ID = 1;
// Strava allows 100 requests every 15 minutes, 1000 per day.
// We limit this script to 50 activities per run to be safe.
const LIMIT = 50; 

console.log(`Starting lap backfill for user ID ${USER_ID}, up to ${LIMIT} activities...`);

// Wait 2 seconds to ensure SQLite DB has initialized 
setTimeout(() => {
  db.all(
    `SELECT id FROM activities WHERE user_id = ? AND laps_json IS NULL AND id > 0 ORDER BY start_date DESC LIMIT ?`,
    [USER_ID, LIMIT],
    async (err, rows) => {
      if (err) {
        console.error("DB error:", err);
        process.exit(1);
      }
      
      console.log(`Found ${rows.length} activities without lap data.`);
      
      if (rows.length === 0) {
        console.log("Nothing to do!");
        process.exit(0);
      }

      try {
        console.log(`Fetching Strava token for user ${USER_ID}...`);
        const { accessToken } = await getStravaTokenForUser(USER_ID);
        
        let successCount = 0;
        
        for (const row of rows) {
           console.log(`Fetching activity ${row.id} from Strava...`);
           const res = await fetch(`https://www.strava.com/api/v3/activities/${row.id}`, {
               headers: { Authorization: `Bearer ${accessToken}` }
           });
           
           if (res.status === 429) {
               console.error("Hit Strava Rate Limit (429)! Stopping backfill.");
               break;
           }
           
           if (!res.ok) {
               console.error(`Error fetching ${row.id}: HTTP ${res.status}`);
               continue;
           }
           
           const data = await res.json();
           
           let lapsJson = null;
           if (data.laps && Array.isArray(data.laps) && data.laps.length > 0) {
              const minimalLaps = data.laps.map(l => ({
                name: l.name,
                distance: l.distance,
                moving_time: l.moving_time,
                average_speed: l.average_speed,
                average_heartrate: l.average_heartrate,
                split: l.split
              }));
              lapsJson = JSON.stringify(minimalLaps);
           } else {
              lapsJson = '[]';
           }
           
           await new Promise((resolve) => {
             db.run(`UPDATE activities SET laps_json = ? WHERE id = ?`, [lapsJson, row.id], (err) => {
                 if (err) {
                     console.error(`DB Update Error for ${row.id}:`, err);
                 } else {
                     console.log(`✅ Updated ${row.id} with laps.`);
                     successCount++;
                 }
                 resolve();
             });
           });
           
           // Sleep for 1 second to respect API limits
           await new Promise(r => setTimeout(r, 1000));
        }
        
        console.log(`\n🎉 Finished! Successfully updated ${successCount} activities.`);
        
      } catch (e) {
          console.error("Failed to get token or process activities:", e);
      }
      
      process.exit(0);
    }
  );
}, 2000);
