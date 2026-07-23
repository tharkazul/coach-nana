const db = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fuzzysort = require('fuzzysort');
const { sendSSEEvent } = require('./sse');
const { generateWithFallback } = require('./ai');


let garminExercises = [];
try {
  garminExercises = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../garmin_exercises.json"), "utf8"),
  );
  console.log(
    `Loaded ${garminExercises.length} Garmin exercises for fuzzy matching.`,
  );
} catch (e) {
  console.error("Could not load garmin_exercises.json:", e);
}
function matchGarminExercise(name) {
  if (!name || garminExercises.length === 0) return null;
  const results = fuzzysort.go(name, garminExercises, {
    key: "exercise_name",
    limit: 1,
  });
  if (results && results.length > 0) {
    // Only return if it's a reasonably good match
    if (results[0].score > 0.4) {
      return results[0].obj;
    }
  }
  return null;
}

function getAMSDateString(date = new Date()) {
  return new Date(date).toLocaleDateString("en-CA", {
    timeZone: "Europe/Amsterdam",
  });
}

function getAMSWeekday(date = new Date()) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "Europe/Amsterdam",
  });
}

function getUserGamificationContext(userId) {
  return new Promise((resolve) => {
    db.all(
      `SELECT start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC`,
      [userId],
      (err, rows) => {
        let streak = 0;
        if (!err && rows && rows.length > 0) {
          const todayStr = getAMSDateString();
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = getAMSDateString(yesterday);

          // Group by unique days
          const activityDates = [
            ...new Set(rows.map((r) => r.start_date.split("T")[0])),
          ];

          if (
            activityDates.includes(todayStr) ||
            activityDates.includes(yesterdayStr)
          ) {
            let currentDate = new Date();
            if (!activityDates.includes(todayStr)) {
              currentDate = yesterday;
            }

            while (true) {
              const checkDateStr = getAMSDateString(currentDate);
              if (activityDates.includes(checkDateStr)) {
                streak++;
                currentDate.setDate(currentDate.getDate() - 1);
              } else {
                break;
              }
            }
          }
        }

        db.get(
          `SELECT SUM(amount) as total FROM bonus_points WHERE user_id = ?`,
          [userId],
          (err2, bpRow) => {
            const bonusPoints = !err2 && bpRow && bpRow.total ? bpRow.total : 0;

            db.get(
              `SELECT title FROM user_titles WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
              [userId],
              (err3, titleRow) => {
                const latestTitle =
                  !err3 && titleRow && titleRow.title
                    ? titleRow.title
                    : "None yet";

                resolve({ streak, bonusPoints, latestTitle });
              },
            );
          },
        );
      },
    );
  });
}

function getUserLeaderboardString(userId) {
  return new Promise((resolve) => {
    db.all(
      `
            SELECT u.username, 
                   (COALESCE(SUM(a.spark_score), 0) + 
                    COALESCE((SELECT SUM(amount) FROM bonus_points WHERE user_id = u.id AND created_at >= datetime('now', '-7 days')), 0)) as total_spark_score
            FROM users u
            LEFT JOIN activities a ON a.user_id = u.id AND a.start_date >= datetime('now', '-7 days')
            WHERE (u.id = ? OR u.id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
            GROUP BY u.id
            ORDER BY total_spark_score DESC
        `,
      [userId, userId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return resolve("");
        const lb = rows
          .map(
            (r, i) =>
              `${i + 1}. ${r.username} (${Math.round(r.total_spark_score)} Points)`,
          )
          .join(", ");
        resolve(`\n\nCurrent Leaderboard: ${lb}`);
      },
    );
  });
}

async function getWeatherContext() {
  try {
    const weatherRes = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=52.3676&longitude=4.9041&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,precipitation_sum,wind_speed_10m_max&timezone=Europe%2FBerlin",
    );
    if (!weatherRes.ok) return "";
    const data = await weatherRes.json();

    const currentTemp = data.current.temperature_2m;
    const currentWind = data.current.wind_speed_10m;
    const currentPrecip = data.current.precipitation;
    const dailyPrecip = data.daily.precipitation_sum[0] || 0;

    let weatherContext = `\nWEATHER CONTEXT:\nCurrent Weather: ${currentTemp}°C, Wind: ${currentWind} km/h, Precipitation: ${currentPrecip} mm/h (Daily total: ${dailyPrecip} mm).\n`;

    // Define miserable conditions (e.g. heavy rain or high wind)
    if (currentPrecip > 1.0 || dailyPrecip > 5.0 || currentWind > 25) {
      weatherContext += `WEATHER ALERT: It is currently very miserable outside (heavy rain or high winds).\n`;
    }

    return weatherContext;
  } catch (e) {
    console.error("Failed to fetch weather context:", e);
    return "";
  }
}

async function getUserMacroPhase(userId) {
  return new Promise((resolve) => {
    db.all(
      `SELECT * FROM milestones WHERE user_id = ? AND is_main = 1 ORDER BY date ASC`,
      [userId],
      (err, rows) => {
        let phase = "BASE";
        if (!err && rows && rows.length > 0) {
          const today = new Date();
          let nextRace = rows.find((m) => new Date(m.date) >= today);
          if (nextRace) {
            let daysUntil = Math.floor(
              (new Date(nextRace.date) - today) / (1000 * 60 * 60 * 24),
            );
            if (daysUntil <= 14) phase = "TAPER";
            else if (daysUntil <= 56) phase = "PEAK";
            else if (daysUntil <= 112) phase = "BUILD";
          }
        }
        resolve(phase);
      },
    );
  });
}

function generatePublicProfile(targetUserId, globalMaxStats) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT username, athlete_context, profile_picture_url FROM users WHERE id = ?`,
      [targetUserId],
      (err, user) => {
        if (err || !user) return resolve(null);

        db.all(
          `SELECT id, name, distance_km, moving_time_min, start_date, sport_type, tss as spark_score FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`,
          [targetUserId],
          async (err, activities) => {
            db.all(
              `SELECT start_date, substr(start_date, 1, 10) as date, tss, sport_type, distance_km, elevation_m, moving_time_min FROM activities WHERE user_id = ? ORDER BY start_date ASC`,
              [targetUserId],
              async (err, rows) => {
                db.all(
                  `SELECT date, weight_kg FROM biometrics WHERE user_id = ? AND date >= date('now', '-30 days') ORDER BY date ASC`,
                  [targetUserId],
                  async (err, weights) => {
                    const trends = {
                      dates: [],
                      tsb: [],
                      ctl: [],
                      atl: [],
                      weight: [],
                    };

                    const tssMap = {};
                    let earliestDateStr = null;
                    if (rows && rows.length > 0) {
                      earliestDateStr = rows[0].date;
                      rows.forEach((r) => {
                        if (!tssMap[r.date]) tssMap[r.date] = 0;
                        tssMap[r.date] += r.tss || 0;
                      });
                    }
                    const weightMap = {};
                    if (weights)
                      weights.forEach(
                        (w) => (weightMap[w.date] = w.weight_kg || null),
                      );

                    let ctl = 0;
                    let atl = 0;
                    if (earliestDateStr) {
                      let currentDate = new Date(earliestDateStr);
                      const today = new Date();
                      currentDate.setUTCHours(0, 0, 0, 0);
                      today.setUTCHours(0, 0, 0, 0);

                      // Calculate how many days to push to trends
                      const totalDays = Math.round(
                        (today - currentDate) / (1000 * 60 * 60 * 24),
                      );
                      const trendStartIdx = totalDays - 29; // We only want the last 30 days

                      let currentDayIdx = 0;
                      while (currentDate <= today) {
                        const dateStr = currentDate.toISOString().split("T")[0];

                        const dailyTss = tssMap[dateStr] || 0;
                        ctl = ctl + (dailyTss - ctl) * (1 - Math.exp(-1 / 42));
                        atl = atl + (dailyTss - atl) * (1 - Math.exp(-1 / 7));

                        if (currentDayIdx >= trendStartIdx) {
                          trends.dates.push(dateStr);
                          trends.ctl.push(ctl);
                          trends.atl.push(atl);
                          trends.tsb.push(ctl - atl);
                          trends.weight.push(weightMap[dateStr] || null);
                        }

                        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                        currentDayIdx++;
                      }
                    }

                    let endurance = Math.min(
                      100,
                      Math.round((ctl / globalMaxStats.ctl) * 100),
                    );
                    let weightTrainingCount = rows
                      ? rows.filter((r) => r.sport_type === "WeightTraining")
                          .length
                      : 0;
                    let totalElevation = rows
                      ? rows.reduce((sum, r) => sum + (r.elevation_m || 0), 0)
                      : 0;
                    let strengthScore =
                      weightTrainingCount * 5 + totalElevation / 1000;
                    let strength = Math.min(
                      100,
                      Math.round(
                        (strengthScore / globalMaxStats.strength) * 100,
                      ),
                    );
                    const uniqueSports = new Set(
                      rows ? rows.map((r) => r.sport_type) : [],
                    ).size;
                    let versatility = Math.min(
                      100,
                      Math.round(
                        (uniqueSports / globalMaxStats.versatility) * 100,
                      ),
                    );
                    let explosiveSessions = rows
                      ? rows.filter(
                          (r) => r.tss / (r.moving_time_min || 1) > 1.2,
                        ).length
                      : 0;
                    let explosiveness = Math.min(
                      100,
                      Math.round(
                        (explosiveSessions / globalMaxStats.explosiveness) *
                          100,
                      ),
                    );

                    const radar = {
                      endurance: endurance || 10,
                      strength: strength || 10,
                      versatility: versatility || 10,
                      explosiveness: explosiveness || 10,
                    };

                    const genericCoachTone =
                      "Empathetic but demanding elite endurance coach.";
                    const currentTsb =
                      trends.tsb.length > 0
                        ? Math.round(trends.tsb[trends.tsb.length - 1])
                        : 0;
                    const prompt = `Write a 2-3 sentence "Coach Highlight" about ${user.username} (refer to them in the third person, e.g., "${user.username} is..."). 
Recent Activities: ${activities.map((a) => a.name).join(", ")}
Current Chronic Training Load (Fitness): ${Math.round(ctl)}
Current Training Stress Balance (Readiness): ${currentTsb}

Write this from the perspective of their coach (Tone: ${genericCoachTone}). Keep it brief, dynamic, and highly personalized based on their recent activities and current readiness! Talk about them to an audience. Do not mention their hidden background or context. Do not include any markdown bolding or headers.`;

                    let highlight = "Keep pushing! They're doing great.";
                    try {
                      highlight = await generateWithFallback(
                        "Generate public profile highlight",
                        prompt,
                        [],
                      );
                    } catch (e) {
                      console.error("Highlight generation failed", e);
                    }

                    const profileData = {
                      username: user.username,
                      profilePictureUrl: user.profile_picture_url,
                      highlight: highlight,
                      activities: activities,
                      trends: trends,
                      radar: radar,
                    };

                    db.run(
                      `INSERT OR REPLACE INTO public_profile_cache (user_id, data, last_updated) VALUES (?, ?, datetime('now'))`,
                      [targetUserId, JSON.stringify(profileData)],
                    );
                    resolve(profileData);
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

async function calculateGlobalMaxStats() {
  return new Promise((resolve) => {
    db.all(
      `SELECT user_id, start_date, substr(start_date, 1, 10) as date, tss, sport_type, elevation_m, moving_time_min FROM activities ORDER BY start_date ASC`,
      [],
      (err, rows) => {
        if (err || !rows)
          return resolve({
            ctl: 1,
            strength: 1,
            versatility: 1,
            explosiveness: 1,
          });

        const userStats = {};
        rows.forEach((r) => {
          if (!userStats[r.user_id]) {
            userStats[r.user_id] = {
              ctlMap: {},
              earliest: r.date,
              weightTrainingCount: 0,
              totalElevation: 0,
              uniqueSports: new Set(),
              explosiveSessions: 0,
            };
          }
          const stats = userStats[r.user_id];
          if (!stats.earliest) stats.earliest = r.date;

          stats.ctlMap[r.date] = (stats.ctlMap[r.date] || 0) + (r.tss || 0);

          if (r.sport_type === "WeightTraining") stats.weightTrainingCount++;
          stats.totalElevation += r.elevation_m || 0;
          if (r.sport_type) stats.uniqueSports.add(r.sport_type);
          if (r.moving_time_min && r.tss / r.moving_time_min > 1.2)
            stats.explosiveSessions++;
        });

        let globalMax = {
          ctl: 1,
          strength: 1,
          versatility: 1,
          explosiveness: 1,
        };

        Object.keys(userStats).forEach((uid) => {
          const stats = userStats[uid];

          let ctl = 0;
          if (stats.earliest) {
            let currentDate = new Date(stats.earliest);
            const today = new Date();
            currentDate.setUTCHours(0, 0, 0, 0);
            today.setUTCHours(0, 0, 0, 0);
            while (currentDate <= today) {
              const dateStr = currentDate.toISOString().split("T")[0];
              const dailyTss = stats.ctlMap[dateStr] || 0;
              ctl = ctl + (dailyTss - ctl) * (1 - Math.exp(-1 / 42));
              currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
          }

          let strengthScore =
            stats.weightTrainingCount * 5 + stats.totalElevation / 1000;
          let versatilityScore = stats.uniqueSports.size;
          let explosivenessScore = stats.explosiveSessions;

          if (ctl > globalMax.ctl) globalMax.ctl = ctl;
          if (strengthScore > globalMax.strength)
            globalMax.strength = strengthScore;
          if (versatilityScore > globalMax.versatility)
            globalMax.versatility = versatilityScore;
          if (explosivenessScore > globalMax.explosiveness)
            globalMax.explosiveness = explosivenessScore;
        });
        resolve(globalMax);
      },
    );
  });
}

async function generateAllPublicProfiles() {
  console.log("🕒 Running 15:00 / 20:00 Profile Caching Routine...");
  // 1. Calculate Global Max Stats using ALL activities
  const globalMaxStats = await calculateGlobalMaxStats();
  console.log(`[Cache] Global Max Stats calculated as:`, globalMaxStats);

  // 2. Iterate all users and generate profile
  db.all(`SELECT id FROM users`, [], async (err, users) => {
    if (err || !users) return;
    for (const u of users) {
      await generatePublicProfile(u.id, globalMaxStats);
      // sleep 2s to not hammer AI
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(
      "✅ All public profiles (Radar Charts & AI Highlights) have been successfully generated and cached!",
    );
  });
}

async function processTokenRefresh(
  refreshToken,
  internalUserId,
  resolve,
  reject,
) {
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      resolve({
        accessToken: tokenData.access_token,
        internalUserId: internalUserId,
      });
    } else {
      reject("Strava token refresh failed during API payload exchange.");
    }
  } catch (e) {
    reject(e);
  }
}

async function getStravaTokenForUser(userIdOrStravaId) {
  return new Promise((resolve, reject) => {
    const lookupVal = String(userIdOrStravaId).trim();

    db.get(
      `
            SELECT u.strava_refresh_token, u.id 
            FROM users u
            LEFT JOIN strava_tokens t ON u.id = t.user_id
            WHERE u.id = ? OR t.strava_id = ? OR CAST(t.strava_id AS TEXT) = ?
        `,
      [userIdOrStravaId, lookupVal, lookupVal],
      async (err, user) => {
        if (err || !user || !user.strava_refresh_token) {
          console.log(
            `⚠️ Mapping index missing for ${lookupVal}. Attempting profile fallback link...`,
          );

          db.get(
            `SELECT id, strava_refresh_token FROM users WHERE strava_refresh_token IS NOT NULL LIMIT 1`,
            [],
            async (fallbackErr, fallbackUser) => {
              if (
                fallbackErr ||
                !fallbackUser ||
                !fallbackUser.strava_refresh_token
              ) {
                return reject(
                  "No Strava token found anywhere in the system for identifier: " +
                    userIdOrStravaId,
                );
              }

              db.run(
                `INSERT OR IGNORE INTO strava_tokens (user_id, access_token, refresh_token, expires_at, strava_id) VALUES (?, ?, ?, ?, ?)`,
                [
                  fallbackUser.id,
                  "temporary",
                  fallbackUser.strava_refresh_token,
                  0,
                  lookupVal,
                ],
                (insertErr) => {
                  if (!insertErr)
                    console.log(
                      `✨ Successfully healed missing index mapping for Strava ID: ${lookupVal}`,
                    );
                },
              );

              processTokenRefresh(
                fallbackUser.strava_refresh_token,
                fallbackUser.id,
                resolve,
                reject,
              );
            },
          );
        } else {
          processTokenRefresh(
            user.strava_refresh_token,
            user.id,
            resolve,
            reject,
          );
        }
      },
    );
  });
}

function getSparkLevelInfo(total_spark) {
  const spark = total_spark || 0;
  const level = Math.floor(8.5 * Math.log10(spark / 250 + 1)) + 1;
  const currentLevelThreshold = 250 * (Math.pow(10, (level - 1) / 8.5) - 1);
  const nextLevelThreshold = 250 * (Math.pow(10, level / 8.5) - 1);

  let progressPercent = 0;
  if (nextLevelThreshold > currentLevelThreshold) {
    progressPercent =
      ((spark - currentLevelThreshold) /
        (nextLevelThreshold - currentLevelThreshold)) *
      100;
  }

  return {
    level,
    currentLevelThreshold,
    nextLevelThreshold,
    progressPercent: Math.min(Math.max(progressPercent, 0), 100),
    totalSpark: spark,
  };
}

function calculateSparkScore(movingTimeMin, avgHr) {
  if (!movingTimeMin) return 0;
  let baseScore = movingTimeMin;
  let bonus = 0;

  if (avgHr) {
    if (avgHr >= 180) bonus = 1.0;
    else if (avgHr >= 160) bonus = 0.4;
    else if (avgHr >= 140) bonus = 0.3;
    else if (avgHr >= 120) bonus = 0.2;
    else if (avgHr >= 100) bonus = 0.0;
    else if (avgHr >= 80) bonus = -0.2;
    else bonus = -0.5;
  }

  return baseScore + baseScore * bonus;
}

function mapStravaSportToSpark(stravaSport) {
  if (!stravaSport) return "Other";
  if (stravaSport.includes("Run")) return "Run";
  if (stravaSport.includes("Ride") || stravaSport.includes("VirtualRide"))
    return "Bike";
  if (stravaSport.includes("Swim")) return "Swim";
  if (stravaSport.includes("WeightTraining") || stravaSport.includes("Workout"))
    return "Strength";
  return "Other";
}

function formatStepsForStrava(stepsJson) {
  if (!stepsJson || stepsJson === "[]" || stepsJson === "null") return null;
  try {
    const steps = JSON.parse(stepsJson);
    if (!steps || steps.length === 0) return null;
    let output = "";
    steps.forEach((s) => {
      if (s.type === "repeat") {
        output += `- Repeat ${s.iterations}x:\n`;
        if (s.steps) {
          s.steps.forEach((sub) => {
            let dur =
              sub.condition_value +
              (sub.condition_type === "time"
                ? " min"
                : sub.condition_type === "distance"
                  ? "m"
                  : " reps");
            let tgt = sub.target_value
              ? sub.target_value
              : sub.zone
                ? `Zone ${sub.zone}`
                : sub.target_type === "no.target"
                  ? "Open"
                  : sub.target_type.replace(".zone", "");
            let extra = sub.weight
              ? ` @ ${sub.weight}kg`
              : sub.target_type !== "no.target"
                ? ` @ ${tgt}`
                : "";
            let name = sub.exerciseName || sub.type;
            output += `    * ${name}: ${dur}${extra}\n`;
          });
        }
      } else {
        let dur =
          s.condition_value +
          (s.condition_type === "time"
            ? " min"
            : s.condition_type === "distance"
              ? "m"
              : " reps");
        let tgt = s.target_value
          ? s.target_value
          : s.zone
            ? `Zone ${s.zone}`
            : s.target_type === "no.target"
              ? "Open"
              : s.target_type.replace(".zone", "");
        let extra = s.weight
          ? ` @ ${s.weight}kg`
          : s.target_type !== "no.target"
            ? ` @ ${tgt}`
            : "";
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
  if (activity.description && activity.description.includes("Spark Target"))
    return;

  db.get(
    "SELECT value FROM athlete_metrics WHERE user_id = ? AND metric = 'strava_opt_out_activities'",
    [userId],
    (err, optOutRow) => {
      let optOutList = [];
      if (optOutRow && optOutRow.value) {
        try {
          optOutList = JSON.parse(optOutRow.value);
        } catch (e) {}
      }

      const activityType = activity.sport_type || activity.type;
      if (optOutList.includes(activityType)) {
        console.log(
          `🚫 Skipping Strava tag for ${activityType} activity ${activity.id} due to user opt-out.`,
        );
        return;
      }

      const tss =
        activity.suffer_score || Math.round((activity.moving_time / 3600) * 50);
      const activityDate = activity.start_date_local
        ? activity.start_date_local.split("T")[0]
        : activity.start_date.split("T")[0];
      const sparkSport = mapStravaSportToSpark(
        activity.sport_type || activity.type,
      );

      db.get(
        "SELECT description, target_spark, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND LOWER(sport) = LOWER(?)",
        [userId, activityDate, sparkSport],
        async (err, plan) => {
          if (err || !plan) return;

          let stepsContent = formatStepsForStrava(plan.steps_json);
          const workoutContent = stepsContent
            ? stepsContent
            : plan.details && plan.details.trim().length > 0
              ? plan.details
              : plan.description;

          const newDescription = `Spark Target: ${plan.target_spark} Spark\nActual: ${Math.round(tss)} Spark\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;

          const finalDescription = activity.description
            ? `${activity.description}\n\n---\n${newDescription}`
            : newDescription;

          try {
            const updateRes = await fetch(
              `https://www.strava.com/api/v3/activities/${activity.id}`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ description: finalDescription }),
              },
            );
            if (updateRes.ok)
              console.log(
                `✅ Strava description updated for ${sparkSport} on ${activityDate}`,
              );
          } catch (e) {
            console.error("Failed to tag Strava activity:", e);
          }
        },
      );
    },
  );
}

async function getStravaActivity(stravaAthleteId, activityId) {
  try {
    console.log(
      `🔍 Processing webhook activity ${activityId} for Strava Athlete ${stravaAthleteId}...`,
    );

    let accessToken;
    let internalUserId;

    try {
      const result = await getStravaTokenForUser(stravaAthleteId);
      accessToken = result.accessToken;
      internalUserId = result.internalUserId;
    } catch (lookupError) {
      console.warn(
        `⚠️ Token mapping failed (${lookupError.message}). Aborting webhook processing.`,
      );
      return;
    }

    const res = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = await res.json();

    if (!data.id) {
      console.error(
        "❌ Failed to pull activity details from Strava payload:",
        data,
      );
      return;
    }

    const tss = data.suffer_score || Math.round((data.moving_time / 3600) * 50);
    const sparkScore = calculateSparkScore(
      data.moving_time / 60,
      data.average_heartrate,
    );

    db.run(
      `INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss, spark_score) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET tss=excluded.tss, spark_score=excluded.spark_score, moving_time_min=excluded.moving_time_min, average_heartrate=excluded.average_heartrate`,
      [
        data.id,
        internalUserId,
        data.name,
        data.sport_type,
        data.distance / 1000,
        data.total_elevation_gain,
        data.moving_time / 60,
        data.average_heartrate || null,
        data.start_date,
        tss,
        sparkScore,
      ],
      (err) => {
        if (!err) {
          updateUserSparkAndCheckLevel(internalUserId);
          sendSSEEvent(internalUserId, "sync_complete", {
            provider: "strava",
            activityId: data.id,
          });

          // Invalidate today's nutrition cache so it incorporates the new workout
          const activityDateStr = data.start_date_local
            ? data.start_date_local.split("T")[0]
            : data.start_date.split("T")[0];
          const todayStr = new Date().toISOString().split("T")[0];
          if (activityDateStr === todayStr) {
            db.run(
              `DELETE FROM nutrition_protocols WHERE user_id = ? AND date = ?`,
              [internalUserId, todayStr],
            );
          }
        }
      },
    );

    const activityDate = data.start_date_local
      ? data.start_date_local.split("T")[0]
      : data.start_date.split("T")[0];
    const sparkSport = mapStravaSportToSpark(data.sport_type);

    db.get(
      "SELECT value FROM athlete_metrics WHERE user_id = ? AND metric = 'strava_opt_out_activities'",
      [internalUserId],
      (err, optOutRow) => {
        let optOutList = [];
        if (optOutRow && optOutRow.value) {
          try {
            optOutList = JSON.parse(optOutRow.value);
          } catch (e) {}
        }

        if (optOutList.includes(data.sport_type)) {
          console.log(
            `🚫 Skipping AI automation and Strava update for ${data.sport_type} activity ${activityId} due to user opt-out.`,
          );
          return;
        }

        db.get(
          "SELECT description, target_spark, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND (LOWER(sport) = LOWER(?) OR LOWER(sport) LIKE '%' || LOWER(?) || '%')",
          [internalUserId, activityDate, sparkSport, sparkSport.slice(0, 5)],
          async (err, plan) => {
            // Fetch the coach tone
            db.get(
              "SELECT coach_tone FROM users WHERE id = ?",
              [internalUserId],
              async (err, userRow) => {
                const tone = userRow
                  ? userRow.coach_tone
                  : "Friendly and motivating";

                let prompt = `The user just completed a ${sparkSport} activity: ${data.name}. They covered ${(data.distance / 1000).toFixed(1)}km in ${Math.round(data.moving_time / 60)} minutes, generating ${Math.round(sparkScore)} Spark. `;
                let newDescription = null;

                if (plan) {
                  let stepsContent = formatStepsForStrava(plan.steps_json);
                  const workoutContent = stepsContent
                    ? stepsContent
                    : plan.details && plan.details.trim().length > 0
                      ? plan.details
                      : plan.description;
                  newDescription = `Spark Target: ${plan.target_spark} Spark\nActual: ${Math.round(sparkScore)} Spark\n\nPlanned Workout:\n${workoutContent}\n\nGenerated by Spark: spark.amsterdamtriathlonassociation.uk`;
                  prompt += `The planned workout for today was: "${workoutContent}" with a target of ${plan.target_spark} Spark. Give a short, 1-2 sentence coach reaction based on your persona tone (${tone}). Praise them if they hit the target or give constructive advice if they missed it.`;
                } else {
                  console.log(
                    `⚠️ No matching ${sparkSport} plan found on ${activityDate}. Generating unplanned reaction.`,
                  );
                  prompt += `This was an unplanned activity. Give a short, 1-2 sentence coach reaction based on your persona tone (${tone}).`;
                }

                // QUEST EVALUATION
                try {
                  const completedQuests = await evaluateQuestsAgainstActivity(
                    internalUserId,
                    {
                      distance_km: data.distance / 1000,
                      moving_time_min: data.moving_time / 60,
                      spark_score: sparkScore,
                    },
                  );

                  if (completedQuests && completedQuests.length > 0) {
                    const newQuest = await generateQuestForUser(internalUserId);

                    prompt += `\n\nCRITICAL INFO: The user ALSO just completed their active quest: "${completedQuests[0].description}" and earned ${completedQuests[0].reward_points} Spark points! `;

                    if (newQuest) {
                      prompt += `I (the system) have automatically assigned them a NEW quest: "${newQuest.description}" (Target: ${newQuest.target_value} ${newQuest.target_metric}, Reward: ${newQuest.reward_points} Spark). You MUST enthusiastically celebrate their completed quest AND announce their brand new quest to keep them motivated!`;
                    } else {
                      prompt += `You MUST enthusiastically celebrate their completed quest!`;
                    }
                  }
                } catch (e) {
                  console.error(
                    "Quest evaluation failed during Strava sync:",
                    e,
                  );
                }

                // 1. Generate AI Coach Response
                try {
                  const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${tone}. Act like a real human in a continuous text message thread.`;
                  const aiReply = await generateWithFallback(
                    prompt,
                    systemPrompt,
                  );
                  db.run(
                    `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
                    [internalUserId, aiReply],
                    (err) => {
                      if (err) {
                        console.error("Error inserting proactive coach message:", err);
                        return;
                      }
                      sendSSEEvent(internalUserId, "unread_message", {
                        message: aiReply,
                        mood: "hype",
                      });
                      console.log(
                        `🤖 Sent proactive coach update for activity ${activityId}`,
                      );
                    }
                  );
                } catch (e) {
                  console.error("Proactive coach activity update failed:", e);
                }

                // 2. Update Strava Description (only if there was a plan)
                if (newDescription) {
                  const updateRes = await fetch(
                    `https://www.strava.com/api/v3/activities/${activityId}`,
                    {
                      method: "PUT",
                      headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ description: newDescription }),
                    },
                  );

                  if (updateRes.ok) {
                    console.log(
                      `✅ Strava description updated for activity ${activityId}!`,
                    );
                  } else {
                    const errorData = await updateRes.json();
                    console.error(
                      `❌ Strava Description Update Failed:`,
                      errorData,
                    );
                  }
                }
              },
            );
          },
        );
      },
    );
  } catch (e) {
    console.error(
      `❌ Fatal Webhook Processing Error for Strava Athlete ${stravaAthleteId}:`,
      e,
    );
  }
}

async function syncAllStravaUsersOnStartup() {
  const SYNC_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown

  db.get(
    `SELECT value FROM system_state WHERE key = 'last_strava_sync_time'`,
    [],
    (err, row) => {
      if (!err && row && row.value) {
        const lastSync = parseInt(row.value, 10);
        if (Date.now() - lastSync < SYNC_COOLDOWN_MS) {
          console.log(
            "⏳ Skipping initial Strava sync to respect rate limits (ran less than 1 hour ago).",
          );
          return;
        }
      }

      db.run(
        `INSERT OR REPLACE INTO system_state (key, value, last_updated) VALUES ('last_strava_sync_time', ?, datetime('now'))`,
        [Date.now().toString()],
      );

      console.log("🔄 Running initial Strava sync for all connected users...");
      db.all(
        "SELECT id FROM users WHERE strava_refresh_token IS NOT NULL",
        [],
        async (err, users) => {
          if (err || !users) return;

          for (const user of users) {
            try {
              const result = await getStravaTokenForUser(user.id);
              const token = result.accessToken;

              const actRes = await fetch(
                "https://www.strava.com/api/v3/athlete/activities?per_page=50",
                {
                  headers: { Authorization: `Bearer ${token}` },
                },
              );

              if (!actRes.ok) {
                console.error(
                  `❌ Strava Sync API Error ${actRes.status} for user ${user.id}`,
                );
                continue;
              }

              const activities = await actRes.json();

              if (Array.isArray(activities)) {
                activities.forEach((act) => {
                  const tss =
                    act.suffer_score ||
                    Math.round((act.moving_time / 3600) * 50);
                  db.run(
                    `INSERT OR IGNORE INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      act.id,
                      user.id,
                      act.name,
                      act.sport_type,
                      act.distance / 1000,
                      act.total_elevation_gain,
                      act.moving_time / 60,
                      act.average_heartrate || 0,
                      act.start_date,
                      tss,
                    ],
                  );
                });
                console.log(`✅ Startup sync complete for user ${user.id}`);
              } else {
                console.error(
                  `❌ Startup sync failed for user ${user.id}: Response is not an array`,
                );
              }
            } catch (err) {
              console.error(`❌ Startup sync failed for user ${user.id}:`, err);
            }
          }
        },
      );
    },
  );
}

async function triggerBackgroundSummary(userId) {
  console.log(`🤖 Triggering background rolling summary for user ${userId}...`);

  db.get(
    `SELECT long_term_memory, coach_tone FROM users WHERE id = ?`,
    [userId],
    async (err, user) => {
      if (err || !user) return;

      db.all(
        `SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 10) ORDER BY id ASC`,
        [userId],
        async (err, historyRows) => {
          if (err || !historyRows || historyRows.length === 0) return;

          const historyText = historyRows
            .map((r) => `${r.role.toUpperCase()}: ${r.content}`)
            .join("\n");
          const currentSummary = user.long_term_memory || "No summary yet.";

          const prompt = `You are a background AI assistant for an endurance coach app. Your job is to update the athlete's long-term memory summary based on recent chat history.
            
CURRENT LONG-TERM MEMORY:
${currentSummary}

RECENT CHAT HISTORY:
${historyText}

INSTRUCTIONS:
Update the long-term memory summary to incorporate any new important facts (injuries, new goals, shifts in mood, new baseline numbers). 
Keep it extremely concise (under 150 words). Do not include pleasantries. Only output the new summary text.`;

          try {
            const newSummary = await generateWithFallback(prompt);
            db.run(`UPDATE users SET long_term_memory = ? WHERE id = ?`, [
              newSummary.trim(),
              userId,
            ]);
            console.log(`✅ Updated long-term memory for user ${userId}`);
          } catch (e) {
            console.error(
              `❌ Failed to update long-term memory for user ${userId}:`,
              e,
            );
          }
        },
      );
    },
  );
}

function updateUserSparkAndCheckLevel(userId) {
  db.get(
    `SELECT total_spark FROM users WHERE id = ?`,
    [userId],
    (err, userRow) => {
      if (err || !userRow) return;
      const oldSpark = userRow.total_spark || 0;
      const oldLevelInfo = getSparkLevelInfo(oldSpark);

      db.get(
        `SELECT SUM(spark_score) as new_total FROM activities WHERE user_id = ?`,
        [userId],
        (err, row) => {
          if (err || !row) return;
          const newSpark = row.new_total || 0;

          db.run(
            `UPDATE users SET total_spark = ? WHERE id = ?`,
            [newSpark, userId],
            (err) => {
              if (err) return;

              const newLevelInfo = getSparkLevelInfo(newSpark);
              if (newLevelInfo.level > oldLevelInfo.level) {
                // Level up!
                triggerLevelUpCoachPrompt(userId, newLevelInfo.level);
              }
            },
          );
        },
      );
    },
  );
}

function triggerLevelUpCoachPrompt(userId, newLevel) {
  db.all(
    `SELECT sport_type, SUM(distance_km) as total_dist, COUNT(id) as count FROM activities WHERE user_id = ? GROUP BY sport_type`,
    [userId],
    (err, rows) => {
      if (err) return;

      let statsStr = rows
        .map(
          (r) =>
            `${r.sport_type}: ${Math.round(r.total_dist)}km (${r.count} sessions)`,
        )
        .join(", ");
      if (!statsStr) statsStr = "No recorded stats yet.";

      db.get(
        `SELECT coach_tone FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err || !user) return;

          const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${user.coach_tone || "Empathetic but demanding"}. Act like a real human in a continuous text message thread.`;
          const prompt = `The athlete just leveled up to Spark Level ${newLevel}! Here are their all-time stats so far: ${statsStr}. Write a short, highly motivating congratulatory message (1-3 sentences). Acknowledge their hard work.`;

          try {
            const aiReply = await generateWithFallback(
              prompt,
              systemPrompt,
              null,
              null,
              userId,
            );
            if (aiReply) {
              db.run(
                `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
                [userId, aiReply],
              );
              sendSSEEvent(userId, "chat_update", {
                role: "coach",
                content: aiReply,
                mood: "hype",
              });
            }
          } catch (e) {
            console.error("Failed to generate level up message", e);
          }
        },
      );
    },
  );
}

async function generateQuestForUser(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 5`,
      [userId],
      async (err, recentActivities) => {
        const activitiesStr =
          recentActivities && recentActivities.length > 0
            ? recentActivities
                .map(
                  (a) =>
                    `- ${a.start_date}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min`,
                )
                .join("\n")
            : "No recent activities logged.";

        const prompt = `Based on the following recent activities of the user, generate a personalized, motivating micro-challenge (Quest) for them to complete in the next 3 days. 
            Recent activities:
            ${activitiesStr}
            
            Return ONLY a JSON object with this exact structure:
            {
            "description": "Short description of the quest (e.g. Run 5k this weekend, or Complete 15km total biking and running)",
            "target_metric": "distance_km", // OR "moving_time_min", "spark_score", or "unique_sports"
            "target_value": 5,
            "target_sport": "Run, Ride", // Comma-separated list of required sports (e.g. Run, Ride, Swim) or 'Any'
            "is_accumulative": false, // Set to true if the goal should sum across multiple activities, false if it must be done in one activity
            "reward_points": 50 // Keep it between 10 and 100
            }`;

        try {
          const aiReply = await generateWithFallback(
            prompt,
            "You are a JSON-only API that outputs valid JSON.",
            null,
            null,
            userId,
          );
          const jsonStr = aiReply
            .replace(/\`\`\`json/g, "")
            .replace(/\`\`\`/g, "")
            .trim();
          const questData = JSON.parse(jsonStr);

          db.run(
            `INSERT INTO user_quests (user_id, description, target_metric, target_value, target_sport, is_accumulative, reward_points) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              userId,
              questData.description,
              questData.target_metric,
              questData.target_value,
              questData.target_sport || "Any",
              questData.is_accumulative ? 1 : 0,
              questData.reward_points,
            ],
            function (err) {
              if (err) return reject(err);
              resolve(questData);
            },
          );
        } catch (e) {
          console.error("Failed to generate background quest:", e);
          resolve(null);
        }
      },
    );
  });
}

async function evaluateQuestsAgainstActivity(userId, activityData) {
  return new Promise((resolve) => {
    db.all(
      `SELECT id, reward_points, description, target_metric, target_value, target_sport, is_accumulative, created_at FROM user_quests WHERE user_id = ? AND status = 'active'`,
      [userId],
      async (err, quests) => {
        if (err || !quests || quests.length === 0) return resolve([]);

        let completedQuests = [];

        for (const q of quests) {
          let targetSports = q.target_sport
            ? q.target_sport.split(",").map((s) => s.trim().toLowerCase())
            : ["any"];
            
          // Add Strava sport variations to ensure activities like VirtualRide count towards Ride quests
          const sportsSet = new Set(targetSports);
          if (sportsSet.has("ride")) {
            sportsSet.add("virtualride");
            sportsSet.add("ebikeride");
            sportsSet.add("mountainbikeride");
            sportsSet.add("gravelride");
          }
          if (sportsSet.has("run")) {
            sportsSet.add("virtualrun");
            sportsSet.add("trailrun");
          }
          targetSports = Array.from(sportsSet);

          const isAnySport = targetSports.includes("any");

          let achievedValue = 0;

          if (q.is_accumulative) {
            // Accumulative evaluation (sum across all matching activities since quest created_at)
            const sumResult = await new Promise((res) => {
              let sportCondition = "";
              if (!isAnySport) {
                const sportIn = targetSports.map((s) => `'${s}'`).join(",");
                sportCondition = `AND LOWER(sport_type) IN (${sportIn})`;
              }

              if (q.target_metric === "unique_sports") {
                db.get(
                  `SELECT COUNT(DISTINCT LOWER(sport_type)) as total FROM activities WHERE user_id = ? AND start_date >= ? ${sportCondition}`,
                  [userId, q.created_at],
                  (err, row) => res(row ? row.total : 0),
                );
              } else {
                const allowedMetrics = [
                  "distance_km",
                  "moving_time_min",
                  "spark_score",
                ];
                const metricCol = allowedMetrics.includes(q.target_metric)
                  ? q.target_metric
                  : "distance_km";
                db.get(
                  `SELECT SUM(${metricCol}) as total FROM activities WHERE user_id = ? AND start_date >= ? ${sportCondition}`,
                  [userId, q.created_at],
                  (err, row) => res(row ? row.total : 0),
                );
              }
            });
            achievedValue = sumResult;
          } else {
            // Single activity evaluation
            if (!isAnySport && activityData.sport_type) {
              if (
                !targetSports.includes(activityData.sport_type.toLowerCase())
              ) {
                continue; // Sport mismatch, skip
              }
            }

            // Map the target metric to the actual activity data properties
            if (q.target_metric === "distance_km")
              achievedValue = activityData.distance_km;
            else if (q.target_metric === "moving_time_min")
              achievedValue = activityData.moving_time_min;
            else if (q.target_metric === "spark_score")
              achievedValue = activityData.spark_score;
            else if (q.target_metric === "unique_sports") achievedValue = 1;
          }

          if (achievedValue >= q.target_value) {
            completedQuests.push(q);
            // Award points
            db.run(
              `INSERT INTO bonus_points (user_id, amount, reason) VALUES (?, ?, ?)`,
              [userId, q.reward_points, `Quest Completed: ${q.description}`],
            );
            // Mark complete
            db.run(
              `UPDATE user_quests SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [q.id],
            );
          }
        }

        resolve(completedQuests);
      },
    );
  });
}

function getEffectiveTokenLimit(user) {
  let expectedLimit = user.subscription_tier === 'spark_plus' ? 50000 : 10000;
  let dbLimit = user.daily_token_limit;
  if (dbLimit === 50000 && expectedLimit === 10000) dbLimit = 10000;
  return dbLimit || expectedLimit;
}

module.exports = {
  matchGarminExercise,
  getAMSDateString,
  getAMSWeekday,
  getUserGamificationContext,
  getUserLeaderboardString,
  getWeatherContext,
  getUserMacroPhase,
  generatePublicProfile,
  calculateGlobalMaxStats,
  generateAllPublicProfiles,
  processTokenRefresh,
  getStravaTokenForUser,
  getSparkLevelInfo,
  calculateSparkScore,
  mapStravaSportToSpark,
  formatStepsForStrava,
  tagStravaActivity,
  getStravaActivity,
  syncAllStravaUsersOnStartup,
  triggerBackgroundSummary,
  updateUserSparkAndCheckLevel,
  triggerLevelUpCoachPrompt,
  generateQuestForUser,
  evaluateQuestsAgainstActivity,
  getEffectiveTokenLimit,
  sendMorningMessage: async () => {
    console.log("🌞 Running scheduled morning message job...");
    const todayStr = getAMSDateString();
    
    // Find all users who have a workout planned for today
    db.all(
      `SELECT u.id, u.coach_tone FROM users u 
       JOIN micro_plan m ON u.id = m.user_id 
       WHERE m.date = ?`,
      [todayStr],
      async (err, rows) => {
        if (err || !rows) return;
        
        // Remove duplicates if they have multiple workouts today
        const uniqueUsers = [];
        const seen = new Set();
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            uniqueUsers.push(r);
          }
        }

        for (const user of uniqueUsers) {
          try {
            const prompt = `It is morning (${todayStr}). Look at the athlete's planned workouts for today and write a short, proactive, energetic morning message to get them pumped up. Acknowledge their recent work if applicable. Keep it under 3 sentences. DO NOT wrap it in JSON.`;
            const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${user.coach_tone || "Friendly"}. Act like a real human in a continuous text message thread.`;
            
            // Generate the message
            const aiReply = await generateWithFallback(prompt, systemPrompt);
            
            // Insert into history
            db.run(
              `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
              [user.id, aiReply],
              (err) => {
                 if (err) { console.error(err); return; }
                 // Push notification bubble to frontend
                 sendSSEEvent(user.id, "unread_message", {
                   message: aiReply,
                   mood: "hype"
                 });
                 console.log(`Sent morning message to user ${user.id}`);
              }
            );
          } catch (e) {
            console.error(`Failed to send morning message to user ${user.id}:`, e);
          }
        }
      }
    );
  }
};
