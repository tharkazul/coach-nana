// create-demo-account.js
const bcrypt = require("bcrypt");
const db = require("./services/db");
const { calculateGlobalMaxStats, generatePublicProfile } = require("./services/utils");

const username = "Demo";
const password = "Demo123";
const athleteContext = "Intermediate runner & hybrid athlete. Trains 4-5 times a week, focusing on 10k/Half-Marathon endurance, core stability, and progressive overload strength.";

async function run() {
  const hashedPassword = await bcrypt.hash(password, 10);

  db.serialize(() => {
    // 1. Create or update Demo user
    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, row) => {
      if (err) {
        console.error("Error querying user:", err);
        process.exit(1);
      }

      let userId;
      if (row) {
        userId = row.id;
        console.log(`Found existing user "${username}" (ID: ${userId}). Updating password and athlete context...`);
        db.run(
          `UPDATE users SET password_hash = ?, athlete_context = ? WHERE id = ?`,
          [hashedPassword, athleteContext, userId]
        );
      } else {
        db.run(
          `INSERT INTO users (username, password_hash, athlete_context, coach_tone, subscription_tier) VALUES (?, ?, ?, ?, ?)`,
          [username, hashedPassword, athleteContext, "Empathetic but demanding elite endurance coach.", "pro"],
          function (err) {
            if (err) {
              console.error("Error creating user:", err);
              process.exit(1);
            }
            userId = this.lastID;
            console.log(`Created new user "${username}" (ID: ${userId}).`);
            seedActivities(userId);
          }
        );
        return;
      }

      seedActivities(userId);
    });
  });
}

function seedActivities(userId) {
  // Clear old activities for clean seed if re-running
  db.run(`DELETE FROM activities WHERE user_id = ?`, [userId], () => {
    const now = new Date();

    const sampleActivities = [
      {
        name: "Morning Tempo Run",
        sport_type: "Run",
        distance_km: 8.2,
        elevation_m: 95,
        moving_time_min: 42,
        average_heartrate: 156,
        daysAgo: 1,
        spark_score: 45
      },
      {
        name: "Full Body Strength & Core",
        sport_type: "WeightTraining",
        distance_km: 0,
        elevation_m: 0,
        moving_time_min: 50,
        average_heartrate: 124,
        daysAgo: 3,
        spark_score: 35
      },
      {
        name: "Easy Recovery Jog",
        sport_type: "Run",
        distance_km: 5.0,
        elevation_m: 30,
        moving_time_min: 30,
        average_heartrate: 132,
        daysAgo: 5,
        spark_score: 25
      }
    ];

    const stmt = db.prepare(`
      INSERT INTO activities 
      (user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, spark_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    sampleActivities.forEach(act => {
      const date = new Date(now.getTime() - act.daysAgo * 24 * 60 * 60 * 1000).toISOString();
      stmt.run(
        userId,
        act.name,
        act.sport_type,
        act.distance_km,
        act.elevation_m,
        act.moving_time_min,
        act.average_heartrate,
        date,
        act.spark_score
      );
    });

    stmt.finalize(() => {
      // Calculate & set total_spark
      db.run(
        `UPDATE users SET total_spark = (SELECT SUM(spark_score) FROM activities WHERE user_id = ?) WHERE id = ?`,
        [userId, userId],
        async (err) => {
          if (err) console.error("Error updating total spark:", err);
          else console.log(`Successfully seeded activities and updated total_spark for "${username}".`);

          try {
            console.log("Generating public profile cache...");
            const maxStats = await calculateGlobalMaxStats();
            await generatePublicProfile(userId, maxStats);
            console.log("Public profile cache generated successfully!");
          } catch (e) {
            console.error("Error generating profile cache:", e);
          }
          process.exit(0);
        }
      );
    });
  });
}

run();
