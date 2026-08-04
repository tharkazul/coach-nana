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
            LEFT JOIN activities a ON a.user_id = u.id AND a.start_date >= datetime('now', '-7 days') AND (u.spark_start_date IS NULL OR substr(a.start_date, 1, 10) >= substr(u.spark_start_date, 1, 10))
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
          `SELECT id, name, distance_km, moving_time_min, start_date, sport_type, COALESCE(spark_score, tss, 0) as spark_score FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`,
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

                    let activeTitle = null;
                    try {
                      activeTitle = await new Promise((res) => {
                        db.get(
                          `SELECT id, title, description FROM user_titles WHERE user_id = ? AND is_active = 1 LIMIT 1`,
                          [targetUserId],
                          (errT, rowT) => res(!errT && rowT ? rowT : null),
                        );
                      });
                    } catch (e) {}

                    const profileData = {
                      username: user.username,
                      profilePictureUrl: user.profile_picture_url,
                      highlight: highlight,
                      activities: activities,
                      trends: trends,
                      radar: radar,
                      activeTitle: activeTitle,
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
      if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
        db.run(
          `UPDATE users SET strava_refresh_token = ? WHERE id = ?`,
          [tokenData.refresh_token, internalUserId],
        );
        db.run(
          `UPDATE strava_tokens SET refresh_token = ?, access_token = ?, expires_at = ? WHERE user_id = ?`,
          [
            tokenData.refresh_token,
            tokenData.access_token,
            tokenData.expires_at || 0,
            internalUserId,
          ],
        );
      }
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

function calculateSparkScore(movingTimeMin, avgHr, fallbackScore = 0) {
  if (!movingTimeMin || movingTimeMin <= 0) return fallbackScore || 0;
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

function getStravaShareSettings(userId, sportType) {
  return new Promise((resolve) => {
    db.all(
      "SELECT metric, value FROM athlete_metrics WHERE user_id = ? AND metric IN ('strava_share_settings', 'strava_opt_out_activities')",
      [userId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return resolve({ shareName: true, shareScore: true, shareStructure: true, shareLink: true });
        }
        const shareRow = rows.find(r => r.metric === 'strava_share_settings');
        const optOutRow = rows.find(r => r.metric === 'strava_opt_out_activities');

        if (shareRow && shareRow.value) {
          try {
            const settings = JSON.parse(shareRow.value);
            if (settings[sportType]) {
              return resolve({
                shareName: !!settings[sportType].shareName,
                shareScore: !!settings[sportType].shareScore,
                shareStructure: !!settings[sportType].shareStructure,
                shareLink: !!settings[sportType].shareLink,
              });
            }
          } catch (e) {}
        }

        if (optOutRow && optOutRow.value) {
          try {
            const optOutList = JSON.parse(optOutRow.value);
            if (Array.isArray(optOutList) && optOutList.includes(sportType)) {
              return resolve({ shareName: false, shareScore: false, shareStructure: false, shareLink: false });
            }
          } catch (e) {}
        }

        resolve({ shareName: true, shareScore: true, shareStructure: true, shareLink: true });
      }
    );
  });
}

function buildStravaUpdatePayload(existingDescription, plan, actualSpark, shareSettings) {
  const { shareName, shareScore, shareStructure, shareLink } = shareSettings;
  if (!shareName && !shareScore && !shareStructure && !shareLink) {
    return null;
  }

  const payload = {};

  if (shareName && plan && plan.description && plan.description.trim().length > 0) {
    payload.name = plan.description.trim();
  }

  const descBlocks = [];
  if (shareScore) {
    if (plan && plan.target_spark != null) {
      descBlocks.push(`Spark Target: ${plan.target_spark} Spark\nActual: ${Math.round(actualSpark)} Spark`);
    } else {
      descBlocks.push(`Actual: ${Math.round(actualSpark)} Spark`);
    }
  }

  if (shareStructure && plan) {
    let stepsContent = formatStepsForStrava(plan.steps_json);
    const workoutContent = stepsContent
      ? stepsContent
      : plan.details && plan.details.trim().length > 0
        ? plan.details
        : null;
    if (workoutContent) {
      descBlocks.push(`Planned Workout:\n${workoutContent}`);
    }
  }

  if (shareLink) {
    descBlocks.push(`Generated by Spark:\nspark.amsterdamtriathlonassociation.uk`);
  }

  if (descBlocks.length > 0) {
    const newDescriptionPart = descBlocks.join("\n\n");
    if (existingDescription && existingDescription.trim().length > 0) {
      if (!existingDescription.includes("Generated by Spark:") && !existingDescription.includes("Spark Target:")) {
        payload.description = `${existingDescription.trim()}\n\n---\n${newDescriptionPart}`;
      }
    } else {
      payload.description = newDescriptionPart;
    }
  }

  if (Object.keys(payload).length === 0) {
    return null;
  }
  return payload;
}

async function tagStravaActivity(userId, activity, token) {
  if (activity.description && activity.description.includes("Spark Target"))
    return;

  const activityType = activity.sport_type || activity.type;
  const shareSettings = await getStravaShareSettings(userId, activityType);
  if (!shareSettings.shareName && !shareSettings.shareScore && !shareSettings.shareStructure && !shareSettings.shareLink) {
    console.log(`🚫 Skipping Strava tag for ${activityType} activity ${activity.id} due to all sharing toggles off.`);
    return;
  }

  const tss =
    activity.suffer_score || Math.round((activity.moving_time / 3600) * 50);
  const activityDate = activity.start_date_local
    ? activity.start_date_local.split("T")[0]
    : activity.start_date.split("T")[0];
  const sparkSport = mapStravaSportToSpark(activityType);

  db.get(
    "SELECT description, target_spark, details, steps_json FROM micro_plan WHERE user_id = ? AND date = ? AND LOWER(sport) = LOWER(?)",
    [userId, activityDate, sparkSport],
    async (err, plan) => {
      if (err || !plan) return;

      const payload = buildStravaUpdatePayload(activity.description, plan, tss, shareSettings);
      if (!payload) return;

      try {
        const updateRes = await fetch(
          `https://www.strava.com/api/v3/activities/${activity.id}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );
        if (updateRes.ok)
          console.log(
            `✅ Strava activity updated for ${sparkSport} on ${activityDate}`,
          );
      } catch (e) {
        console.error("Failed to tag Strava activity:", e);
      }
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

    db.get(
      `SELECT spark_start_date FROM users WHERE id = ?`,
      [internalUserId],
      (err, uRow) => {
        const userStartDateDay = uRow && uRow.spark_start_date ? uRow.spark_start_date.substring(0, 10) : null;
        const actStartDateDay = data.start_date ? data.start_date.substring(0, 10) : null;

        let sparkScore = 0;
        if (!userStartDateDay || (actStartDateDay && actStartDateDay >= userStartDateDay)) {
          sparkScore = calculateSparkScore(
            data.moving_time / 60,
            data.average_heartrate,
            tss,
          );
        }

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
        }

        db.run(
          `INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss, spark_score, laps_json) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET tss=excluded.tss, spark_score=excluded.spark_score, moving_time_min=excluded.moving_time_min, average_heartrate=excluded.average_heartrate, laps_json=excluded.laps_json`,
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
            lapsJson,
          ],
          async (err) => {
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
              const todayStr = getAMSDateString();
              if (activityDateStr === todayStr) {
                db.run(
                  `DELETE FROM nutrition_protocols WHERE user_id = ? AND date = ?`,
                  [internalUserId, todayStr],
                );
              }
              
              const activityDate = data.start_date_local
                ? data.start_date_local.split("T")[0]
                : data.start_date.split("T")[0];
              const sparkSport = mapStravaSportToSpark(data.sport_type);
              const shareSettings = await getStravaShareSettings(internalUserId, data.sport_type);

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
                      const updatePayload = buildStravaUpdatePayload(data.description, plan, sparkScore, shareSettings);

                      if (plan) {
                        let stepsContent = formatStepsForStrava(plan.steps_json);
                        const workoutContent = stepsContent
                          ? stepsContent
                          : plan.details && plan.details.trim().length > 0
                            ? plan.details
                            : plan.description;
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

                      // AI MUSCLE IMPACT ANALYSIS
                      try {
                         analyzeMuscleImpact(internalUserId, data, sparkSport, activityDate);
                      } catch(e) {
                         console.error("AI Muscle Impact Analysis failed:", e);
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

                      // 2. Update Strava Activity (title / description if enabled in settings)
                      if (updatePayload) {
                        const updateRes = await fetch(
                          `https://www.strava.com/api/v3/activities/${activityId}`,
                          {
                            method: "PUT",
                            headers: {
                              Authorization: `Bearer ${accessToken}`,
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify(updatePayload),
                          },
                        );

                        if (updateRes.ok) {
                          console.log(
                            `✅ Strava activity updated for activity ${activityId}!`,
                          );
                        } else {
                          const errorData = await updateRes.json();
                          console.error(
                            `❌ Strava Activity Update Failed:`,
                            errorData,
                          );
                        }
                      }
                    },
                  );
                },
              );
            }
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
        "SELECT id, spark_start_date FROM users WHERE strava_refresh_token IS NOT NULL",
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
                const userStartDateDay = user.spark_start_date ? user.spark_start_date.substring(0, 10) : null;
                activities.forEach((act) => {
                  const tss =
                    act.suffer_score ||
                    Math.round((act.moving_time / 3600) * 50);
                  const actStartDateDay = act.start_date ? act.start_date.substring(0, 10) : null;
                  let sparkScore = 0;
                  if (!userStartDateDay || (actStartDateDay && actStartDateDay >= userStartDateDay)) {
                    sparkScore = calculateSparkScore(
                      act.moving_time / 60,
                      act.average_heartrate,
                      tss,
                    );
                  }
                  db.run(
                    `INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss, spark_score) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(id) DO UPDATE SET tss=excluded.tss, spark_score=excluded.spark_score, moving_time_min=excluded.moving_time_min, average_heartrate=excluded.average_heartrate`,
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
                      sparkScore,
                    ],
                  );
                });
                updateUserSparkAndCheckLevel(user.id);
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
        `SELECT body_part, severity, notes, status FROM athlete_niggles WHERE user_id = ?`,
        [userId],
        async (err, niggleRows) => {
          const activeNiggles = (niggleRows || []).filter((n) => n.status === "active");
          const resolvedNiggles = (niggleRows || []).filter((n) => n.status === "resolved");

          const activeText =
            activeNiggles.length > 0
              ? activeNiggles
                  .map(
                    (n) =>
                      `- ${n.body_part}: Severity ${n.severity}/5. ${n.notes || ""}`,
                  )
                  .join("\n")
              : "No active injuries or niggles reported. Athlete is 100% healthy.";

          const resolvedText =
            resolvedNiggles.length > 0
              ? resolvedNiggles
                  .map((n) => `- ${n.body_part}: HEALED / RESOLVED`)
                  .join("\n")
              : "None.";

          db.all(
            `SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC`,
            [userId],
            async (err, historyRows) => {
              if (err) return;

              const historyText =
                historyRows && historyRows.length > 0
                  ? historyRows
                      .map((r) => `${r.role.toUpperCase()}: ${r.content}`)
                      .join("\n")
                  : "No recent chat.";

              const currentSummary = user.long_term_memory || "No summary yet.";

              const prompt = `You are a background AI assistant for an endurance coach app. Your job is to update the athlete's long-term memory summary based on recent chat history and REAL-TIME injury records.

CURRENT LONG-TERM MEMORY:
${currentSummary}

REAL-TIME ACTIVE INJURIES (REALITY / TRUTH):
${activeText}

REAL-TIME RESOLVED / HEALED INJURIES (REALITY / TRUTH):
${resolvedText}

RECENT CHAT HISTORY:
${historyText}

INSTRUCTIONS & CRITICAL RULES FOR INJURIES:
1. INJURY TRUTH: Refer strictly to the ACTIVE INJURIES list above. If an injury (e.g. heel, knee, ankle, back) is listed under RESOLVED INJURIES or is NOT in ACTIVE INJURIES, REMOVE IT COMPLETELY from current physical issues in the summary! Note it as fully healed or omit it.
2. DO NOT state that a resolved or non-active injury is currently hurting, bothering, or limiting the athlete.
3. Update the long-term memory summary to incorporate any new important facts (new goals, shifts in mood, new baseline numbers).
4. Keep it extremely concise (under 150 words). Do not include pleasantries. Only output the updated summary text.`;

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
    },
  );
}

function updateUserSparkAndCheckLevel(userId) {
  db.get(
    `SELECT total_spark, spark_start_date FROM users WHERE id = ?`,
    [userId],
    (err, userRow) => {
      if (err || !userRow) return;
      const oldSpark = userRow.total_spark || 0;
      const oldLevelInfo = getSparkLevelInfo(oldSpark);
      const sparkStartDateDay = userRow.spark_start_date ? userRow.spark_start_date.substring(0, 10) : null;

      const query = sparkStartDateDay
        ? `SELECT SUM(spark_score) as new_total FROM activities WHERE user_id = ? AND substr(start_date, 1, 10) >= ?`
        : `SELECT SUM(spark_score) as new_total FROM activities WHERE user_id = ?`;
      const queryParams = sparkStartDateDay ? [userId, sparkStartDateDay] : [userId];

      db.get(
        query,
        queryParams,
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

async function generateQuestForUser(userId, poolType = "personal", previousQuest = null) {
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

        const prompt = `Based on the following recent activities of the user, generate a personalized, motivating micro-challenge (Quest) for them to complete in the next 1 to 7 days. 
            Recent activities:
            ${activitiesStr}
            
            Return ONLY a JSON object with this exact structure:
            {
            "description": "Short description of the quest (e.g. Run 5k this weekend, or Complete 15km total biking and running over 3 days)",
            "target_metric": "distance_km", // OR "moving_time_min", "spark_score", or "unique_sports"
            "target_value": 5,
            "target_sport": "Run, Ride", // Comma-separated list of required sports (e.g. Run, Ride, Swim) or 'Any'
            "is_accumulative": false, // Set to true if the goal should sum across multiple activities, false if it must be done in one activity
            "reward_points": 50, // Keep it between 10 and 100
            "time_limit_days": 3 // Number of days to complete the quest (between 1 and 7)
            }`;

        try {
          const aiReply = await generateWithFallback(
            prompt,
            "You are a JSON-only API that outputs valid JSON.",
            null,
            null,
            userId,
            poolType
          );
          const jsonStr = aiReply
            .replace(/\`\`\`json/g, "")
            .replace(/\`\`\`/g, "")
            .trim();
          const questData = JSON.parse(jsonStr);
          const daysLimit = Math.max(1, Math.min(7, parseInt(questData.time_limit_days) || 3));

          db.run(
            `INSERT INTO user_quests (user_id, description, target_metric, target_value, target_sport, is_accumulative, reward_points, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`,
            [
              userId,
              questData.description,
              questData.target_metric,
              questData.target_value,
              questData.target_sport || "Any",
              questData.is_accumulative ? 1 : 0,
              questData.reward_points,
              daysLimit,
            ],
            function (err) {
              if (err) return reject(err);
              resolve(questData);
            },
          );
        } catch (e) {
          console.error("Failed to generate quest:", e);
          resolve(null);
        }
      },
    );
  });
}

async function evaluateAndProgressQuests(userId) {
  // Ensure existing active quests without expires_at get a default expiration date
  await new Promise((resolve) => {
    db.run(
      `UPDATE user_quests SET expires_at = datetime(created_at, '+3 days') WHERE user_id = ? AND expires_at IS NULL AND status = 'active'`,
      [userId],
      () => resolve(),
    );
  });

  const quests = await new Promise((resolve) => {
    db.all(
      `SELECT * FROM user_quests WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
      (err, rows) => resolve(rows || []),
    );
  });

  if (quests.length === 0) {
    const newQuest = await generateQuestForUser(userId, "common");
    if (newQuest) {
      newQuest.current_value = 0;
      return [newQuest];
    }
    return [];
  }

  const activities = await new Promise((resolve) => {
    db.all(
      `SELECT sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC`,
      [userId],
      (err, rows) => resolve(rows || []),
    );
  });

  let activeCount = 0;
  const now = Date.now();

  for (const q of quests) {
    if (q.status === "active") {
      if (activeCount >= 1) {
        // Enforce maximum of 1 active quest by voiding/closing older ones
        q.status = "closed";
        db.run(`UPDATE user_quests SET status = 'closed' WHERE id = ?`, [q.id]);
        continue;
      }
      
      const expiresAtStr = (q.expires_at || "").trim();
      let isExpired = false;
      let expiresTs = null;
      if (expiresAtStr) {
        const isoString =
          expiresAtStr.replace(" ", "T") +
          (expiresAtStr.includes("Z") || expiresAtStr.includes("+") ? "" : "Z");
        expiresTs = new Date(isoString).getTime();
        if (now >= expiresTs) {
          isExpired = true;
        }
      }

      if (isExpired) {
        q.status = "expired";
        db.run(`UPDATE user_quests SET status = 'expired' WHERE id = ?`, [q.id]);
        continue;
      }

      let targetSports = q.target_sport
        ? q.target_sport.split(",").map((s) => s.trim().toLowerCase())
        : ["any"];
      const sportsSet = new Set(targetSports);
      if (sportsSet.has("ride") || sportsSet.has("bike") || sportsSet.has("cycling")) {
        sportsSet.add("ride");
        sportsSet.add("virtualride");
        sportsSet.add("ebikeride");
        sportsSet.add("mountainbikeride");
        sportsSet.add("gravelride");
      }
      if (sportsSet.has("run") || sportsSet.has("running")) {
        sportsSet.add("run");
        sportsSet.add("virtualrun");
        sportsSet.add("trailrun");
        sportsSet.add("treadmill");
      }
      if (sportsSet.has("swim") || sportsSet.has("swimming")) {
        sportsSet.add("swim");
        sportsSet.add("openwaterswim");
        sportsSet.add("poolswim");
      }
      targetSports = Array.from(sportsSet);
      const isAnySport = targetSports.includes("any");

      const createdStr = (q.created_at || "").trim();
      const createdIso =
        createdStr.replace(" ", "T") +
        (createdStr.includes("Z") || createdStr.includes("+") ? "" : "Z");
      const createdTs = new Date(createdIso).getTime() - 60 * 60 * 1000; // 1-hour grace period for timestamps

      const matchingActivities = activities.filter((a) => {
        if (!a.start_date) return false;
        const actStr = String(a.start_date).trim();
        const actIso =
          actStr.replace(" ", "T") +
          (actStr.includes("Z") || actStr.includes("+") || actStr.includes("T") ? "" : "Z");
        const actTs = new Date(actIso).getTime();

        // Must be AFTER created_at AND BEFORE expires_at
        if (actTs < createdTs) return false;
        if (expiresTs && actTs > expiresTs) return false;

        if (!isAnySport && a.sport_type) {
          if (!targetSports.includes(a.sport_type.toLowerCase())) {
            return false;
          }
        }
        return true;
      });

      let val = 0;
      if (q.target_metric === "unique_sports") {
        const unique = new Set(matchingActivities.map((a) => (a.sport_type || "").toLowerCase()));
        val = unique.size;
      } else {
        const metricCol = ["distance_km", "moving_time_min", "spark_score"].includes(q.target_metric)
          ? q.target_metric
          : "distance_km";
        if (q.is_accumulative) {
          val = matchingActivities.reduce((sum, a) => sum + (parseFloat(a[metricCol]) || 0), 0);
        } else {
          val = matchingActivities.reduce((max, a) => Math.max(max, parseFloat(a[metricCol]) || 0), 0);
        }
      }

      val = Math.round(val * 100) / 100;
      q.current_value = val;

      if (val >= q.target_value) {
        q.status = "completed";
        const completedAt = new Date().toISOString().replace("T", " ").substring(0, 19);
        q.completed_at = completedAt;
        db.run(
          `INSERT INTO bonus_points (user_id, amount, reason) VALUES (?, ?, ?)`,
          [userId, q.reward_points, `Quest Completed: ${q.description}`],
        );
        db.run(
          `UPDATE user_quests SET status = 'completed', completed_at = ? WHERE id = ?`,
          [completedAt, q.id],
        );
      } else {
        activeCount++;
      }
    } else {
      if (q.status === "completed" && q.current_value === undefined) {
        q.current_value = q.target_value;
      }
    }
  }

  // Automatically generate a new quest if no active quest remains
  if (activeCount === 0) {
    const newQuest = await generateQuestForUser(userId, "common");
    if (newQuest) {
      newQuest.current_value = 0;
      quests.unshift(newQuest);
    }
  }

  return quests;
}

async function evaluateQuestsAgainstActivity(userId, activityData) {
  const allQuests = await evaluateAndProgressQuests(userId);
  return allQuests.filter((q) => q.status === "completed");
}

async function calculateQuestProgress(userId, quest) {
  return new Promise((resolve) => {
    let targetSports = quest.target_sport
      ? quest.target_sport.split(",").map((s) => s.trim().toLowerCase())
      : ["any"];
    const sportsSet = new Set(targetSports);
    if (sportsSet.has("ride") || sportsSet.has("bike") || sportsSet.has("cycling")) {
      sportsSet.add("ride");
      sportsSet.add("virtualride");
      sportsSet.add("ebikeride");
      sportsSet.add("mountainbikeride");
      sportsSet.add("gravelride");
    }
    if (sportsSet.has("run") || sportsSet.has("running")) {
      sportsSet.add("run");
      sportsSet.add("virtualrun");
      sportsSet.add("trailrun");
      sportsSet.add("treadmill");
    }
    if (sportsSet.has("swim") || sportsSet.has("swimming")) {
      sportsSet.add("swim");
      sportsSet.add("openwaterswim");
      sportsSet.add("poolswim");
    }
    targetSports = Array.from(sportsSet);
    const isAnySport = targetSports.includes("any");

    let sportCondition = "";
    if (!isAnySport) {
      const sportIn = targetSports.map((s) => `'${s}'`).join(",");
      sportCondition = `AND LOWER(sport_type) IN (${sportIn})`;
    }

    const cutoff = quest.completed_at || quest.expires_at;
    let timeCondition = "";
    let params = [userId, quest.created_at];

    if (cutoff) {
      timeCondition = ` AND start_date <= ?`;
      params.push(cutoff);
    }

    if (quest.is_accumulative) {
      if (quest.target_metric === "unique_sports") {
        db.get(
          `SELECT COUNT(DISTINCT LOWER(sport_type)) as total FROM activities WHERE user_id = ? AND start_date >= ? ${timeCondition} ${sportCondition}`,
          params,
          (err, row) => resolve(row ? row.total || 0 : 0)
        );
      } else {
        const allowedMetrics = ["distance_km", "moving_time_min", "spark_score"];
        const metricCol = allowedMetrics.includes(quest.target_metric)
          ? quest.target_metric
          : "distance_km";
        db.get(
          `SELECT SUM(${metricCol}) as total FROM activities WHERE user_id = ? AND start_date >= ? ${timeCondition} ${sportCondition}`,
          params,
          (err, row) => resolve(row ? (row.total ? parseFloat(row.total.toFixed(2)) : 0) : 0)
        );
      }
    } else {
      if (quest.target_metric === "unique_sports") {
        db.get(
          `SELECT COUNT(id) as total FROM activities WHERE user_id = ? AND start_date >= ? ${timeCondition} ${sportCondition}`,
          params,
          (err, row) => resolve(row && row.total > 0 ? 1 : 0)
        );
      } else {
        const allowedMetrics = ["distance_km", "moving_time_min", "spark_score"];
        const metricCol = allowedMetrics.includes(quest.target_metric)
          ? quest.target_metric
          : "distance_km";
        db.get(
          `SELECT MAX(${metricCol}) as max_val FROM activities WHERE user_id = ? AND start_date >= ? ${timeCondition} ${sportCondition}`,
          params,
          (err, row) => resolve(row ? (row.max_val ? parseFloat(row.max_val.toFixed(2)) : 0) : 0)
        );
      }
    }
  });
}

async function analyzeMuscleImpact(userId, activityData, sparkSport, activityDate) {
  const prompt = `The athlete completed a ${sparkSport} activity: ${activityData.name}. 
  Distance: ${(activityData.distance / 1000).toFixed(1)}km
  Time: ${Math.round(activityData.moving_time / 60)} min.
  Sets: ${activityData.sets_json ? JSON.stringify(activityData.sets_json) : "None"}
  
  Based on this, what is the training impact (stimulus) on the involved muscle groups? Output ONLY a JSON array mapping body parts to an impact score (1-100). 
  Use standard naming (e.g. "quads", "calves", "shoulders", "lower-back", "chest", "lats", "glutes", "hamstrings", "core").
  Example format:
  [{"body_part": "quads", "impact_score": 30}, {"body_part": "shoulders", "impact_score": 15}]
  `;

  const systemPrompt = `You are a sports science AI. Output ONLY valid JSON, no markdown formatting, no preamble.`;

  try {
    // Import here to avoid circular dependency issues if any, though it's likely already imported
    const { generateWithFallback } = require('./ai'); 
    let result = await generateWithFallback(prompt, systemPrompt);
    result = result.replace(/```json/g, "").replace(/```/g, "").trim();
    const fatigueArray = JSON.parse(result);
    
    if (Array.isArray(fatigueArray)) {
      const stmt = db.prepare(`
        INSERT INTO athlete_muscle_status (user_id, body_part, fatigue_score, development_score) 
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, body_part) DO UPDATE SET 
          fatigue_score = fatigue_score + excluded.fatigue_score,
          development_score = development_score + excluded.development_score,
          last_updated = CURRENT_TIMESTAMP
      `);
      fatigueArray.forEach(f => {
        // Fallback to f.fatigue_score just in case the AI uses the old format
        const score = f.impact_score || f.fatigue_score;
        if(f.body_part && score) {
          stmt.run(userId, f.body_part, score, score);
        }
      });
      stmt.finalize();
      console.log(`✅ Saved muscle impact for ${activityData.name}`);
    }
  } catch(e) {
    console.error("Failed to parse muscle impact JSON", e);
  }
}

async function runDailyRecoveryJob() {
  console.log("🌙 Running daily recovery & degradation job...");

  // 1. Muscle Status Recovery (Fatigue & Development)
  // Fatigue decays by 40% (x 0.6), Development decays by 10% (x 0.9)
  db.run(`UPDATE athlete_muscle_status SET 
            fatigue_score = fatigue_score * 0.6,
            development_score = development_score * 0.9 
          WHERE fatigue_score > 0 OR development_score > 0`, (err) => {
      if (err) console.error("Muscle status recovery error:", err);
  });

  // Delete status logs that have dropped below 1 for both to keep DB clean
  db.run(`DELETE FROM athlete_muscle_status WHERE fatigue_score < 1 AND development_score < 1`);

  // 2. Niggle Auto-Degradation
  // If an injury has been active for a multiple of 3 days, reduce severity.
  db.all(`SELECT id, user_id, body_part, severity, reported_date FROM athlete_niggles WHERE status = 'active' AND severity > 0`, async (err, niggles) => {
      if (err || !niggles) return;

      const now = new Date();
      for (const niggle of niggles) {
          const reported = new Date(niggle.reported_date);
          const diffTime = Math.abs(now - reported);
          const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays > 0 && diffDays % 3 === 0) {
              const newSeverity = niggle.severity - 1;
              
              if (newSeverity <= 0) {
                  // Injury Resolved!
                  db.run(`UPDATE athlete_niggles SET severity = 0, status = 'resolved', resolved_date = CURRENT_TIMESTAMP WHERE id = ?`, [niggle.id]);
                  
                  // Notify the user via AI coach
                  db.get(`SELECT coach_tone FROM users WHERE id = ?`, [niggle.user_id], async (err, user) => {
                      const tone = user ? user.coach_tone : "Friendly";
                      const prompt = `The athlete's ${niggle.body_part} injury has automatically fully healed and been marked as resolved after ${diffDays} days. Send a proactive, encouraging message (1-2 sentences) letting them know their ${niggle.body_part} is now cleared for full activity, but they should still listen to their body. DO NOT use JSON.`;
                      const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${tone}. Act like a real human in a continuous text message thread.`;
                      
                      try {
                          const aiReply = await generateWithFallback(prompt, systemPrompt);
                          
                          db.run(
                              `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
                              [niggle.user_id, aiReply]
                          );
                          
                          sendSSEEvent(niggle.user_id, "unread_message", {
                              message: aiReply,
                              mood: "hype"
                          });
                      } catch(e) {
                          console.error("AI Coach Recovery message failed:", e);
                      }
                  });

              } else {
                  // Injury recovering but not resolved
                  db.run(`UPDATE athlete_niggles SET severity = ? WHERE id = ?`, [newSeverity, niggle.id]);
              }
          }
      }
  });
}

function resetDailyTokensForAllUsers() {
  const todayStr = getAMSDateString();
  db.run(
    `UPDATE users SET 
       daily_token_usage = 0, 
       common_token_usage = 0, 
       last_token_reset_date = ?, 
       daily_token_limit = CASE WHEN subscription_tier = 'spark_plus' THEN 50000 ELSE 5000 END
     WHERE last_token_reset_date != ? OR last_token_reset_date IS NULL`,
    [todayStr, todayStr],
    function (err) {
      if (err) {
        console.error("❌ Error running daily token reset:", err);
      } else if (this.changes > 0) {
        console.log(`🪙 Successfully reset tokens for ${this.changes} inactive/due user(s) for date: ${todayStr}`);
      }
    },
  );
}

function resetDailyNutritionForAllUsers() {
  const todayStr = getAMSDateString();
  console.log(`🥗 Daily midnight nutrition reset executed for AMS date: ${todayStr}`);
}

function getEffectiveTokenLimit(user) {
  let expectedLimit = user.subscription_tier === 'spark_plus' ? 50000 : 5000;
  let dbLimit = user.daily_token_limit;
  if (dbLimit === 50000 && expectedLimit === 5000) dbLimit = 5000;
  return dbLimit || expectedLimit;
}

module.exports = {
  resetDailyTokensForAllUsers,
  resetDailyNutritionForAllUsers,
  getStravaShareSettings,
  buildStravaUpdatePayload,
  runDailyRecoveryJob,
  analyzeMuscleImpact,
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
  evaluateAndProgressQuests,
  calculateQuestProgress,
  getEffectiveTokenLimit,
  sendMorningMessage: async () => {
    console.log("🌞 Running scheduled morning message job...");
    const todayStr = getAMSDateString();
    
    // Find all users and any workouts they have planned for today
    db.all(
      `SELECT u.id, u.coach_tone, m.sport, m.description, m.details 
       FROM users u 
       LEFT JOIN micro_plan m ON u.id = m.user_id AND m.date = ?`,
      [todayStr],
      async (err, rows) => {
        if (err || !rows) return;
        
        // Group by user
        const usersMap = new Map();
        for (const r of rows) {
          if (!usersMap.has(r.id)) {
            usersMap.set(r.id, {
              id: r.id,
              coach_tone: r.coach_tone,
              workouts: []
            });
          }
          if (r.sport) {
            usersMap.get(r.id).workouts.push({
              sport: r.sport,
              description: r.description,
              details: r.details
            });
          }
        }

        for (const user of usersMap.values()) {
          try {
            let prompt = `It is morning (${todayStr}). You are the athlete's coach. Write a short, proactive, energetic morning message. Acknowledge their recent work if applicable. `;
            
            if (user.workouts.length > 0) {
              prompt += `They have the following workouts planned for today: ${JSON.stringify(user.workouts)}. Get them pumped up for it! `;
            } else {
              prompt += `They have a REST DAY today (no workouts planned). Encourage them to recover well and enjoy the day. `;
            }
            prompt += `Keep it under 3 sentences. DO NOT wrap it in JSON.`;
            
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
