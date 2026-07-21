const express = require('express');
const router = express.Router();
const db = require('../services/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { GarminConnect } = require("@flow-js/garmin-connect");
const { authenticateToken } = require('../services/auth');
const { sseClients, sendSSEEvent } = require('../services/sse');
const { generateWithFallback } = require('../services/ai');
const { encrypt, decrypt } = require('../services/crypto');
const {
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
  evaluateQuestsAgainstActivity
} = require('../services/utils');

const SPORT_MAP = {
  Run: { sportTypeId: 1, sportTypeKey: "running" },
  Bike: { sportTypeId: 2, sportTypeKey: "cycling" },
  Swim: { sportTypeId: 4, sportTypeKey: "swimming" },
  Strength: { sportTypeId: 5, sportTypeKey: "strength_training" },
};

const STEP_TYPE_MAP = {
  warmup: { id: 1, key: "warmup" },
  cooldown: { id: 2, key: "cooldown" },
  interval: { id: 3, key: "interval" },
  recovery: { id: 4, key: "recovery" },
  rest: { id: 5, key: "rest" },
};

const TARGET_TYPE_MAP = {
  "no.target": { id: 1, key: "no.target" },
  "power.zone": { id: 2, key: "power.zone" },
  "heart.rate.zone": { id: 4, key: "heart.rate.zone" },
  "speed.zone": { id: 5, key: "speed.zone" },
  "pace.zone": { id: 6, key: "pace.zone" },
};

const CONDITION_TYPE_MAP = {
  time: { id: 2, key: "time" },
  time_sec: { id: 2, key: "time" },
  distance: { id: 3, key: "distance" },
  "lap.button": { id: 1, key: "lap.button" },
  reps: { id: 10, key: "reps" },
};

router.get("/webhook/strava", (req, res) => {
  const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || "STRAVA";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Strava Webhook Verified!");
      res.json({ "hub.challenge": challenge });
    } else {
      res.sendStatus(403);
    }
  }
});

router.post("/webhook/strava", (req, res) => {
  console.log(
    "📥 STRAVA WEBHOOK INCOMING PAYLOAD:",
    JSON.stringify(req.body, null, 2),
  );
  const { aspect_type, object_id, owner_id, object_type } = req.body;

  if (aspect_type === "create" && object_type === "activity") {
    console.log(`🏃‍♂️ New Strava activity detected! Fetching ID: ${object_id}`);
    getStravaActivity(owner_id, object_id);
  }

  res.status(200).send("EVENT_RECEIVED");
});

router.post("/api/user/settings/garmin", authenticateToken, (req, res) => {
  const { garminUsername, garminPassword } = req.body;

  if (!garminUsername || !garminPassword) {
    return res
      .status(400)
      .json({ error: "Username and password are required." });
  }

  const encryptedPassword = encrypt(garminPassword);

  db.run(
    `UPDATE users SET garmin_username = ?, garmin_password = ? WHERE id = ?`,
    [garminUsername, encryptedPassword, req.user.id],
    function (err) {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to save Garmin credentials." });
      res.json({ message: "Garmin connection secured successfully!" });
    },
  );
});

router.post("/api/user/settings/strava", authenticateToken, (req, res) => {
  const { stravaRefreshToken } = req.body;

  if (!stravaRefreshToken) {
    return res.status(400).json({ error: "Missing Strava refresh token." });
  }

  db.run(
    `UPDATE users SET strava_refresh_token = ? WHERE id = ?`,
    [stravaRefreshToken, req.user.id],
    function (err) {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to save Strava integration." });
      res.json({ message: "Strava connected successfully!" });
    },
  );
});

router.post("/api/sync-strava", authenticateToken, async (req, res) => {
  db.get(
    "SELECT strava_refresh_token FROM users WHERE id = ?",
    [req.user.id],
    async (err, user) => {
      if (err || !user || !user.strava_refresh_token) {
        return res
          .status(400)
          .json({ error: "Strava token missing from settings." });
      }

      try {
        const tokenRes = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: user.strava_refresh_token,
          }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token)
          throw new Error(
            "Strava rejected the token. Please check your credentials.",
          );

        const actRes = await fetch(
          "https://www.strava.com/api/v3/athlete/activities?per_page=200",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );

        const activities = await actRes.json();

        activities.forEach((act) => {
          const tss =
            act.suffer_score || Math.round((act.moving_time / 3600) * 50);
          const sparkScore = calculateSparkScore(
            act.moving_time / 60,
            act.average_heartrate,
          );
          db.run(
            `INSERT INTO activities (id, user_id, name, sport_type, distance_km, elevation_m, moving_time_min, average_heartrate, start_date, tss, spark_score) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET tss=excluded.tss, spark_score=excluded.spark_score, moving_time_min=excluded.moving_time_min, average_heartrate=excluded.average_heartrate`,
            [
              act.id,
              req.user.id,
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
          tagStravaActivity(req.user.id, act, tokenData.access_token);
        });

        updateUserSparkAndCheckLevel(req.user.id);

        res.json({
          message: `Successfully synced ${activities.length} activities!`,
        });
      } catch (err) {
        console.error("Strava Sync Error:", err);
        res
          .status(500)
          .json({ error: "Strava sync failed. Check server logs." });
      }
    },
  );
});

router.post(
  "/api/user/settings/strava-exchange",
  authenticateToken,
  async (req, res) => {
    const { code } = req.body;

    if (!code)
      return res.status(400).json({ error: "No authorization code provided." });

    try {
      const response = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          code: code,
          grant_type: "authorization_code",
        }),
      });

      const data = await response.json();

      if (data.errors)
        return res
          .status(400)
          .json({ error: "Strava rejected the authorization." });

      db.run(`UPDATE users SET strava_refresh_token = ? WHERE id = ?`, [
        data.refresh_token,
        req.user.id,
      ]);

      db.run(
        `INSERT OR REPLACE INTO strava_tokens (user_id, access_token, refresh_token, expires_at, strava_id) VALUES (?, ?, ?, ?, ?)`,
        [
          req.user.id,
          data.access_token,
          data.refresh_token,
          data.expires_at,
          String(data.athlete.id),
        ],
        (err) => {
          if (err)
            return res.status(500).json({ error: "Failed to map Strava ID." });
          res.json({ message: "Strava connected successfully!" });
        },
      );
    } catch (error) {
      res
        .status(500)
        .json({ error: "Server error during Strava authentication." });
    }
  },
);

router.post("/api/user/disconnect/strava", authenticateToken, (req, res) => {
  db.get(
    `SELECT access_token FROM strava_tokens WHERE user_id = ?`,
    [req.user.id],
    async (err, row) => {
      if (row && row.access_token) {
        try {
          await fetch("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { Authorization: `Bearer ${row.access_token}` },
          });
        } catch (e) {
          console.error("Failed to deauthorize Strava:", e);
        }
      }
      db.run(`UPDATE users SET strava_refresh_token = NULL WHERE id = ?`, [
        req.user.id,
      ]);
      db.run(
        `DELETE FROM strava_tokens WHERE user_id = ?`,
        [req.user.id],
        (err) => {
          if (err)
            return res
              .status(500)
              .json({ error: "Failed to disconnect Strava from database." });
          res.json({ message: "Strava disconnected successfully!" });
        },
      );
    },
  );
});

router.post("/api/user/disconnect/strava", authenticateToken, (req, res) => {
  db.get(
    `SELECT access_token FROM strava_tokens WHERE user_id = ?`,
    [req.user.id],
    async (err, row) => {
      if (row && row.access_token) {
        try {
          await fetch("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { Authorization: `Bearer ${row.access_token}` },
          });
        } catch (e) {
          console.error("Failed to deauthorize Strava:", e);
        }
      }
      db.run(`UPDATE users SET strava_refresh_token = NULL WHERE id = ?`, [
        req.user.id,
      ]);
      db.run(
        `DELETE FROM strava_tokens WHERE user_id = ?`,
        [req.user.id],
        (err) => {
          if (err)
            return res
              .status(500)
              .json({ error: "Failed to disconnect Strava from database." });
          res.json({ message: "Strava disconnected successfully!" });
        },
      );
    },
  );
});

router.post("/api/user/disconnect/garmin", authenticateToken, (req, res) => {
  db.run(
    `UPDATE users SET garmin_username = NULL, garmin_password = NULL WHERE id = ?`,
    [req.user.id],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to disconnect Garmin." });
      res.json({ message: "Garmin disconnected successfully!" });
    },
  );
});

router.post("/api/sync-garmin", authenticateToken, async (req, res) => {
  console.log("DEBUG: Sync route triggered for user:", req.user.id);
  const selectedWorkouts = req.body.workouts;

  if (!selectedWorkouts || selectedWorkouts.length === 0) {
    return res.status(400).json({ error: "No workouts selected for sync." });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        `SELECT garmin_username, garmin_password FROM users WHERE id = ?`,
        [req.user.id],
        (err, row) => {
          if (err || !row) reject(new Error("User credentials not found"));
          else resolve(row);
        },
      );
    });

    const decryptedPassword = decrypt(user.garmin_password);
    const GCClient = new GarminConnect({
      username: user.garmin_username,
      password: decryptedPassword,
    });

    console.log("DEBUG: Attempting login for user:", user.garmin_username);
    await GCClient.login(user.garmin_username, decryptedPassword);
    const client = GCClient.client || GCClient.http;
    if (!client) throw new Error("Garmin client initialization failed.");

    const todayStr = getAMSDateString();
    const workouts = await new Promise((resolve, reject) => {
      db.all(
        `SELECT date, sport, description, target_spark, steps_json FROM micro_plan WHERE user_id = ? AND date >= ?`,
        [req.user.id, todayStr],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });

    const workoutsToSync = workouts.filter((w) =>
      selectedWorkouts.some((sw) => sw.date === w.date && sw.sport === w.sport),
    );

    if (workoutsToSync.length === 0)
      return res
        .status(400)
        .json({ error: "No valid workouts found to sync." });

    let syncedCount = 0;

    for (const workout of workoutsToSync) {
      if (workout.sport === "Rest" || !SPORT_MAP[workout.sport]) continue;

      const sportDef = SPORT_MAP[workout.sport];
      let stepsArray = [];
      try {
        stepsArray = JSON.parse(workout.steps_json);
      } catch (e) {
        stepsArray = [];
      }

      if (stepsArray.length === 0) {
        let durationMins = Math.max(
          5,
          Math.round((workout.target_spark / 55) * 60),
        );
        stepsArray = [
          {
            type: "interval",
            condition_type: "time",
            condition_value: durationMins,
            target_type: "no.target",
          },
        ];
      }

      const garminSteps = stepsArray.map((step, index) => {
        if (step.type === "repeat") {
          return {
            type: "RepeatGroupDTO",
            stepOrder: index + 1,
            smartRepeat: false,
            numberOfIterations: step.iterations || 1,
            workoutSteps: (step.steps || []).map((subStep, subIndex) => {
              const nType =
                subStep.type === "drill" ? "interval" : subStep.type;
              const sDef = STEP_TYPE_MAP[nType] || STEP_TYPE_MAP["interval"];
              const tDef =
                TARGET_TYPE_MAP[subStep.target_type] ||
                TARGET_TYPE_MAP["no.target"];
              const cDef =
                CONDITION_TYPE_MAP[subStep.condition_type] ||
                CONDITION_TYPE_MAP["time"];

              const sDTO = {
                type: "ExecutableStepDTO",
                stepOrder: subIndex + 1,
                stepType: { stepTypeId: sDef.id, stepTypeKey: sDef.key },
                endCondition: {
                  conditionTypeId: cDef.id,
                  conditionTypeKey: cDef.key,
                },
                endConditionValue:
                  subStep.condition_type === "time"
                    ? subStep.condition_value * 60
                    : subStep.condition_value,
                targetType: {
                  workoutTargetTypeId: tDef.id,
                  workoutTargetTypeKey: tDef.key,
                },
                targetValueOne: null,
                targetValueTwo: null,
                zoneNumber: subStep.zone ? parseInt(subStep.zone, 10) : null,
              };
              if (subStep.target_value) {
                if (
                  subStep.target_value.includes("min/km") ||
                  subStep.target_type === "pace.exact"
                ) {
                  const match = subStep.target_value.match(/(\d+):(\d+)/);
                  if (match) {
                    const speedMs =
                      1000 /
                      (parseInt(match[1], 10) * 60 + parseInt(match[2], 10));
                    sDTO.targetType = {
                      workoutTargetTypeId: TARGET_TYPE_MAP["pace.zone"].id,
                      workoutTargetTypeKey: TARGET_TYPE_MAP["pace.zone"].key,
                    };
                    sDTO.targetValueOne = speedMs * 0.95;
                    sDTO.targetValueTwo = speedMs * 1.05;
                    sDTO.zoneNumber = null;
                  }
                } else if (subStep.target_value.toLowerCase().includes("w")) {
                  const match = subStep.target_value.match(/(\d+)/);
                  if (match) {
                    const watts = parseInt(match[1], 10);
                    sDTO.targetType = {
                      workoutTargetTypeId: TARGET_TYPE_MAP["power.zone"].id,
                      workoutTargetTypeKey: TARGET_TYPE_MAP["power.zone"].key,
                    };
                    sDTO.targetValueOne = watts * 0.9;
                    sDTO.targetValueTwo = watts * 1.1;
                    sDTO.zoneNumber = null;
                  }
                }
              }
              if (subStep.condition_type === "distance") {
                sDTO.preferredEndConditionUnit = {
                  unitId: 1,
                  unitKey: "meter",
                  factor: 100,
                };
              }
              if (subStep.weight) {
                sDTO.weightValue = subStep.weight;
                sDTO.weightUnit = { unitId: 9, unitKey: "kilogram" };
              }
              if (subStep.exerciseName) {
                const match = matchGarminExercise(subStep.exerciseName);
                if (match) {
                  sDTO.category = match.category_key;
                  sDTO.exerciseName = match.exercise_key;
                } else {
                  sDTO.description = subStep.exerciseName; // Fallback to notes if no match
                }
              }
              return sDTO;
            }),
          };
        }

        const normalizedType = step.type === "drill" ? "interval" : step.type;
        const stepDef =
          STEP_TYPE_MAP[normalizedType] || STEP_TYPE_MAP["interval"];
        const targetDef =
          TARGET_TYPE_MAP[step.target_type] || TARGET_TYPE_MAP["no.target"];
        const conditionDef =
          CONDITION_TYPE_MAP[step.condition_type] || CONDITION_TYPE_MAP["time"];

        const stepDTO = {
          type: "ExecutableStepDTO",
          stepOrder: index + 1,
          stepType: { stepTypeId: stepDef.id, stepTypeKey: stepDef.key },
          endCondition: {
            conditionTypeId: conditionDef.id,
            conditionTypeKey: conditionDef.key,
          },
          endConditionValue:
            step.condition_type === "time"
              ? step.condition_value * 60
              : step.condition_value,
          targetType: {
            workoutTargetTypeId: targetDef.id,
            workoutTargetTypeKey: targetDef.key,
          },
          targetValueOne: null,
          targetValueTwo: null,
          zoneNumber: step.zone ? parseInt(step.zone, 10) : null,
        };
        if (step.target_value) {
          if (
            step.target_value.includes("min/km") ||
            step.target_type === "pace.exact"
          ) {
            const match = step.target_value.match(/(\d+):(\d+)/);
            if (match) {
              const speedMs =
                1000 / (parseInt(match[1], 10) * 60 + parseInt(match[2], 10));
              stepDTO.targetType = {
                workoutTargetTypeId: TARGET_TYPE_MAP["pace.zone"].id,
                workoutTargetTypeKey: TARGET_TYPE_MAP["pace.zone"].key,
              };
              stepDTO.targetValueOne = speedMs * 0.95;
              stepDTO.targetValueTwo = speedMs * 1.05;
              stepDTO.zoneNumber = null;
            }
          } else if (step.target_value.toLowerCase().includes("w")) {
            const match = step.target_value.match(/(\d+)/);
            if (match) {
              const watts = parseInt(match[1], 10);
              stepDTO.targetType = {
                workoutTargetTypeId: TARGET_TYPE_MAP["power.zone"].id,
                workoutTargetTypeKey: TARGET_TYPE_MAP["power.zone"].key,
              };
              stepDTO.targetValueOne = watts * 0.9;
              stepDTO.targetValueTwo = watts * 1.1;
              stepDTO.zoneNumber = null;
            }
          }
        }

        if (step.condition_type === "distance") {
          stepDTO.preferredEndConditionUnit = {
            unitId: 1,
            unitKey: "meter",
            factor: 100,
          };
        }
        if (step.weight) {
          stepDTO.weightValue = step.weight;
          stepDTO.weightUnit = { unitId: 9, unitKey: "kilogram" };
        }
        if (step.exerciseName) {
          const match = matchGarminExercise(step.exerciseName);
          if (match) {
            stepDTO.category = match.category_key;
            stepDTO.exerciseName = match.exercise_key;
          } else {
            stepDTO.description = step.exerciseName; // Fallback to notes if no match
          }
        }
        return stepDTO;
      });

      const wkt = {
        workoutName: `Spark: ${workout.sport}`,
        description: workout.description,
        sportType: sportDef,
        workoutSegments: [
          { segmentOrder: 1, sportType: sportDef, workoutSteps: garminSteps },
        ],
      };

      if (workout.sport === "Swim") {
        wkt.poolLength = 25;
        wkt.poolLengthUnit = { unitId: 1, unitKey: "meter", factor: 100 };
      }

      try {
        const response = await client.post(
          "https://connectapi.garmin.com/workout-service/workout",
          wkt,
        );
        const workoutId = response?.workoutId || response?.data?.workoutId;
        if (workoutId) {
          await client.post(
            `https://connectapi.garmin.com/workout-service/schedule/${workoutId}`,
            { date: workout.date },
          );
          syncedCount++;
        }
      } catch (err) {
        console.error(
          `❌ Sync Failed for ${workout.sport} on ${workout.date}:`,
          err.message,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    res.json({
      success: true,
      message: `Successfully pushed ${syncedCount} structured workouts!`,
    });
  } catch (err) {
    console.error("CRITICAL ERROR in sync-garmin:", err);
    return res
      .status(500)
      .json({ error: "Server sync failed", details: err.message });
  }
});

module.exports = router;
