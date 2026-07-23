const express = require('express');
const router = express.Router();
const db = require('../services/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
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

router.get("/api/micro-plan", authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM micro_plan WHERE user_id = ? ORDER BY date ASC`,
    [req.user.id],
    (err, rows) => {
      res.json(rows || []);
    },
  );
});

router.get("/api/user/metrics", authenticateToken, (req, res) => {
  db.all(
    `SELECT id, metric, value FROM athlete_metrics WHERE user_id = ? ORDER BY metric ASC`,
    [req.user.id],
    (err, rows) => {
      if (err)
        return res.status(500).json({ error: "Failed to load metrics." });
      res.json(rows || []);
    },
  );
});

router.post("/api/user/metrics", authenticateToken, (req, res) => {
  const { metrics } = req.body;
  if (!metrics || !Array.isArray(metrics)) {
    return res.status(400).json({ error: "Invalid metrics array format." });
  }

  db.serialize(() => {
    // We will just clear all custom metrics and re-insert what the user passed, or update them.
    // But some might have been auto-added by the AI, and we MUST preserve system metrics like strava_opt_out_activities.
    db.run(
      `DELETE FROM athlete_metrics WHERE user_id = ? AND metric != 'strava_opt_out_activities'`,
      [req.user.id],
    );
    const stmt = db.prepare(
      `INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, ?, ?)`,
    );
    metrics.forEach((m) => {
      if (m.metric !== "strava_opt_out_activities") {
        stmt.run(req.user.id, m.metric, m.value);
      }
    });
    stmt.finalize();
    res.json({ message: "Metrics updated successfully!" });
  });
});

router.get("/api/user/activities/types", authenticateToken, (req, res) => {
  db.all(
    `SELECT DISTINCT sport_type FROM activities WHERE user_id = ? ORDER BY sport_type ASC`,
    [req.user.id],
    (err, rows) => {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to load activity types." });
      res.json(rows.map((r) => r.sport_type));
    },
  );
});

router.post("/api/user/strava-opt-out", authenticateToken, (req, res) => {
  const { optOutActivities } = req.body;
  if (!Array.isArray(optOutActivities)) {
    return res.status(400).json({ error: "optOutActivities must be an array" });
  }
  const val = JSON.stringify(optOutActivities);

  db.run(
    `INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, 'strava_opt_out_activities', ?) 
            ON CONFLICT(user_id, metric) DO UPDATE SET value=excluded.value`,
    [req.user.id, val],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to update preferences." });
      res.json({ success: true });
    },
  );
});

router.get("/api/activity/:id", authenticateToken, (req, res) => {
  const activityId = req.params.id;

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
        if (!tokenData.access_token) {
          return res.status(401).json({ error: "Strava rejected the token." });
        }

        const actRes = await fetch(
          `https://www.strava.com/api/v3/activities/${activityId}`,
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );

        if (!actRes.ok) {
          return res
            .status(actRes.status)
            .json({ error: "Activity not found on Strava." });
        }

        const activityData = await actRes.json();

        // Extract sets or best efforts for the AI Coach
        let extractedSets = [];

        if (activityData.best_efforts && activityData.best_efforts.length > 0) {
          extractedSets = activityData.best_efforts.map((be) => ({
            name: be.name,
            time: be.moving_time,
            distance: be.distance,
          }));
        }
        // Strava strength training structure (defensive parsing)
        if (activityData.sport_type === "WeightTraining") {
          // Try to pull from sets, exercises, or laps (depending on how partner apps sync)
          if (activityData.sets) extractedSets = activityData.sets;
          else if (activityData.exercises)
            extractedSets = activityData.exercises;
          else if (activityData.laps) extractedSets = activityData.laps; // sometimes sets are stored as laps
        }

        if (extractedSets.length > 0) {
          db.run(`UPDATE activities SET sets_json = ? WHERE id = ?`, [
            JSON.stringify(extractedSets),
            activityId,
          ]);
          activityData.sets_json = extractedSets; // attach for frontend
        }

        res.json(activityData);
      } catch (err) {
        console.error("Single Activity Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch activity details." });
      }
    },
  );
});

router.get("/api/dashboard-data", authenticateToken, (req, res) => {
  db.all(
    `SELECT substr(start_date, 1, 10) as date, sport_type, SUM(spark_score) as daily_spark FROM activities WHERE user_id = ? GROUP BY date, sport_type ORDER BY date ASC`,
    [req.user.id],
    (err, rows) => {
      if (!rows) return res.json([]);
      const aggregated = {};
      rows.forEach((r) => {
        const mappedSport = mapStravaSportToSpark(r.sport_type);
        const key = `${r.date}_${mappedSport}`;
        if (!aggregated[key])
          aggregated[key] = {
            date: r.date,
            sport_type: mappedSport,
            daily_spark: 0,
          };
        aggregated[key].daily_spark += r.daily_spark;
      });
      res.json(Object.values(aggregated));
    },
  );
});

router.get("/api/history", authenticateToken, (req, res) => {
  db.all(
    `SELECT id, name, sport_type, start_date, spark_score, distance_km, moving_time_min, average_heartrate FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 50`,
    [req.user.id],
    (err, rows) => {
      res.json(rows || []);
    },
  );
});

router.post("/api/micro-plan", authenticateToken, (req, res) => {
  const { date, sport, description, target_spark, details, steps_json } =
    req.body;
  db.run(
    `INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      date,
      sport,
      description,
      target_spark,
      details,
      steps_json || "[]",
    ],
    (err) => {
      if (err) {
        console.error("POST /api/micro-plan error:", err.message);
        return res
          .status(500)
          .json({ error: "Failed to create plan", details: err.message });
      }
      res.json({ success: true });
    },
  );
});

router.post("/api/micro-plan/push-forward", authenticateToken, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: "date is required" });

  const userId = req.user.id;

  // Shift everything from `date` up to `date + 6 days` forward by 1 day
  db.run(
    `UPDATE micro_plan SET date = DATE(date, '+1 day') WHERE user_id = ? AND date >= ? AND date <= DATE(?, '+6 days')`,
    [userId, date, date],
    function (err) {
      if (err)
        return res.status(500).json({ error: "Failed to update micro plan." });

      const msg = `I've shifted your schedule starting from ${date} forward by one day. Take it easy and recover!`;
      db.run(
        `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'assistant', ?, 'empathetic')`,
        [userId, msg],
        (err2) => {
          res.json({ success: true, message: msg });
        },
      );
    },
  );
});

router.post("/api/micro-plan/day", authenticateToken, (req, res) => {
  const { date, workouts } = req.body;
  if (!date || !Array.isArray(workouts))
    return res.status(400).json({ error: "Invalid data format" });

  db.run(
    `DELETE FROM micro_plan WHERE user_id = ? AND date = ?`,
    [req.user.id, date],
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to update plan" });

      if (workouts.length === 0) return res.json({ success: true });

      const stmt = db.prepare(
        `INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      workouts.forEach((w) => {
        stmt.run(
          req.user.id,
          date,
          w.sport,
          w.description,
          w.target_spark,
          w.details,
          w.steps_json || "[]",
        );
      });
      stmt.finalize();
      res.json({ success: true });
    },
  );
});

router.put("/api/micro-plan/:id", authenticateToken, (req, res) => {
  const { date, sport, description, target_spark, details, steps_json } =
    req.body;
  db.run(
    `UPDATE micro_plan SET date = ?, sport = ?, description = ?, target_spark = ?, details = ?, steps_json = ? WHERE id = ? AND user_id = ?`,
    [
      date,
      sport,
      description,
      target_spark,
      details,
      steps_json,
      req.params.id,
      req.user.id,
    ],
    (err) => {
      if (err) {
        console.error("PUT /api/micro-plan error:", err.message);
        return res
          .status(500)
          .json({ error: "Failed to update plan", details: err.message });
      }
      res.json({ success: true });
    },
  );
});

router.delete("/api/micro-plan/:id", authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM micro_plan WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to delete plan" });
      res.json({ success: true });
    },
  );
});

router.post("/api/generate-plan", authenticateToken, async (req, res) => {
  const { targetDate } = req.body;

  db.get(
    `SELECT coach_tone, athlete_context, gender, training_availability FROM users WHERE id = ?`,
    [req.user.id],
    async (err, user) => {
      if (err) {
        console.error(
          "DB Error fetching user context for plan generation:",
          err,
        );
        return res
          .status(500)
          .json({ error: "Failed to load athlete context." });
      }
      if (!user) {
        return res.status(500).json({ error: "Athlete context not found." });
      }

      db.all(
        `SELECT metric, value FROM athlete_metrics WHERE user_id = ?`,
        [req.user.id],
        async (err, metricsRows) => {
          const metricsText =
            metricsRows && metricsRows.length > 0
              ? metricsRows.map((m) => `${m.metric}: ${m.value}`).join(", ")
              : "None explicitly recorded yet.";

          db.all(
            `SELECT sport_type, start_date, sets_json FROM activities WHERE user_id = ? AND sets_json IS NOT NULL AND sets_json != '[]' ORDER BY start_date DESC LIMIT 5`,
            [req.user.id],
            async (err, recentSetsRows) => {
              let recentSetsText = "No recent strength/PB data recorded.";
              if (recentSetsRows && recentSetsRows.length > 0) {
                recentSetsText = recentSetsRows
                  .map(
                    (row) =>
                      `Date: ${row.start_date}, Sport: ${row.sport_type}, Details: ${row.sets_json}`,
                  )
                  .join("\n");
              }

              let availabilityText = "No specific schedule boundaries set.";
              if (user.training_availability) {
                try {
                  const availObj = JSON.parse(user.training_availability);
                  availabilityText = Object.entries(availObj)
                    .map(([day, data]) => {
                      return `- ${day.charAt(0).toUpperCase() + day.slice(1)}: ${data.status} (Max minutes: ${data.max_minutes})`;
                    })
                    .join("\n            ");
                } catch (e) {}
              }

              db.all(
                `SELECT body_part, severity, notes FROM athlete_niggles WHERE user_id = ? AND status = 'active'`,
                [req.user.id],
                async (err, niggleRows) => {
                  let nigglesText = "No active injuries or niggles reported.";
                  if (niggleRows && niggleRows.length > 0) {
                    nigglesText = JSON.stringify(niggleRows);
                  }

                  const systemPrompt = `You are Coach Spark, an elite Ironman Triathlon and endurance coach.
                Tone: ${user.coach_tone || "empathetic"}
                Athlete Context: ${user.athlete_context || "General endurance athlete"}
                Gender: ${user.gender || "Prefer not to say"}
                ${user.gender === "Female" ? "IMPORTANT: Adjust training load taking the menstrual cycle into consideration. Distribute exercises carefully around the physically demanding days." : ""}
                Schedule Boundaries:
                ${availabilityText}
                Key Physiological Metrics: ${metricsText}
                Recent Strength & PB History:
                ${recentSetsText}
                ACTIVE INJURIES/NIGGLES:
                ${nigglesText}
            
            CRITICAL RULES:
            0. ACTIVITY TYPE (SPORT): The 'sport' field is REQUIRED for every workout in the JSON and MUST be exactly one of: 'Run', 'Bike', 'Swim', 'Strength', 'Rest'. Never leave it blank. For Strength workouts, you MUST include an "exerciseName" in each step.
            1. You are generating a 7-day training plan starting exactly on ${targetDate}.
            2. SCHEDULE BOUNDARIES: You MUST adhere to the daily time constraints listed in "Schedule Boundaries". If a day is marked 'blocked' or max_minutes is 0, you are strictly forbidden from scheduling any active training on that day (you may only schedule 'Rest'). Do not spike the ATL excessively on a single day to compensate; distribute the load safely across the 'Available' and 'Time-Capped' days.
            3. INJURY GUARDRAILS: The athlete has active injuries listed above. You MUST alter the training plan based on this data to prevent further injury.
               - If an injury is Lower Body (Severity 3+): Strictly avoid high-impact running. Substitute required aerobic load with swimming or indoor cycling.
               - If an injury affects Grip/Hands: Substitute swimming or heavy upper-body strength with running or indoor cycling.
               - If Severity is 5: Schedule complete rest for the affected area.
               - Whenever you modify a template due to an active injury, you must add a brief note in the 'description' explaining the substitution (e.g., 'Swapped today's run for a ride to protect your Achilles').
            4. You must append a JSON code block at the very end of your response containing the schedule.
            5. Use metric measurements exclusively (km, kg, km/h). DO NOT repeat greetings, filler words, or preamble.
            6. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout, create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
            7. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Use simple, standard exercise names (e.g., "Barbell Back Squat", "Dumbbell Lunge"). Between sets, use a "rest" step with "condition_type": "time_sec" and set "condition_value" to the number of SECONDS to rest (e.g., 90 for 90 seconds). Reference the Athlete Context for their past weights, and push for progressive overload.
        6. TARGETS: If a workout requires a specific pace (e.g. "4:15 min/km") or power (e.g. "250W") instead of a generic zone, add a "target_value" string to the step object (e.g., "target_value": "4:15 min/km"). Otherwise, continue using "zone": <number>.
        7. SPARK TARGETS: Calculate "target_spark" for your plan. 1 minute of endurance activity = 1.2 Spark. For high intensity (Zone 3/4+), use 1.3 or 1.4 Spark per min. For Zone 1/Rest, use 1.0 Spark per min. For Strength Training, allocate exactly 0.5 Spark per set (ignore rest time).

        WORKOUT PLANNING (CRITICAL):
        If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
        The JSON must be a valid Array of objects. Format it EXACTLY JSON FORMAT REQUIRED AT THE END OF YOUR RESPONSE:
        \`\`\`json
        [
          {
            "date": "YYYY-MM-DD",
            "sport": "Run", 
            "description": "5k Speed Intervals",
            "target_spark": 80,
            "details": "Push hard on the intervals, recover fully on the rests.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"recovery\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
          },
          {
            "date": "YYYY-MM-DD",
            "sport": "Strength", 
            "description": "Leg Day Burner",
            "target_spark": 40,
            "details": "Focus on depth and explosion.",
            "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 5, \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"repeat\\", \\"iterations\\": 3, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"reps\\", \\"condition_value\\": 10, \\"weight\\": 80, \\"exerciseName\\": \\"Barbell Squat\\", \\"target_type\\": \\"no.target\\"}, {\\"type\\": \\"rest\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 2, \\"target_type\\": \\"no.target\\"}]}]"
          }
        ]
        \`\`\`
        *Note: Ensure "steps_json" is formatted as a stringified JSON array as shown in the examples. Exercises MUST go in steps_json, NOT details!*`;

                  const ctl = user.current_ctl || 0;
                  const atl = user.current_atl || 0;
                  const tsb = ctl - atl;
                  const phase = user.training_phase || "Base";

                  const userPrompt = `Please generate a 7-day training plan for me starting on ${targetDate}. 
        
        Here are my current physiological metrics to govern the volume and intensity of this block:
        - Training Phase: ${phase}
        - Fitness (CTL): ${ctl}
        - Fatigue (ATL): ${atl}
        - Form (TSB): ${tsb}

        Analyze my Form (TSB). If I am highly fatigued (negative TSB), prioritize recovery. If I am fresh (positive TSB), you can push the intensity. Give me a quick encouraging summary of the week's focus based on these metrics, and then provide the JSON block.`;

                  try {
                    let aiReply = await generateWithFallback(
                      userPrompt,
                      systemPrompt,
                    );
                    let planUpdated = false;

                    const jsonMatch = aiReply.match(/```json([\s\S]*?)```/);
                    if (jsonMatch) {
                      try {
                        const planData = JSON.parse(jsonMatch[1]);
                        const affectedDates = [
                          ...new Set(planData.map((day) => day.date)),
                        ];

                        if (affectedDates.length > 0) {
                          const placeholders = affectedDates
                            .map(() => "?")
                            .join(",");

                          db.run(
                            `DELETE FROM micro_plan WHERE user_id = ? AND date IN (${placeholders})`,
                            [req.user.id, ...affectedDates],
                            (err) => {
                              if (err)
                                console.error(
                                  "Failed to clear old plan data:",
                                  err,
                                );

                              const stmt = db.prepare(`
                                INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) 
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `);

                              planData.forEach((day) => {
                                stmt.run(
                                  req.user.id,
                                  day.date,
                                  day.sport,
                                  day.description,
                                  day.target_spark,
                                  day.details,
                                  day.steps_json || "[]",
                                );
                              });
                              stmt.finalize();
                            },
                          );
                        }

                        planUpdated = true;
                        aiReply = aiReply
                          .replace(/```json[\s\S]*?```/, "")
                          .trim();
                      } catch (e) {
                        console.error("Failed to parse AI JSON block", e);
                      }
                    }

                    let mood = "default";
                    const lowerReply = aiReply.toLowerCase();
                    if (
                      lowerReply.includes("crush") ||
                      lowerReply.includes("!")
                    )
                      mood = "hype";
                    if (
                      lowerReply.includes("disappoint") ||
                      lowerReply.includes("skip")
                    )
                      mood = "disappointed";

                    const simulatedUserMessage = `Can you build my plan for next week, Spark?`;
                    const coachAcknowledgement = `I've just crunched your latest numbers and pushed a fresh ${phase} phase plan to your dashboard. Go check it out—you're going to crush it!`;

                    db.run(
                      `INSERT INTO chat_history (user_id, role, content) VALUES (?, 'user', ?)`,
                      [req.user.id, simulatedUserMessage],
                    );
                    db.run(
                      `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`,
                      [req.user.id, coachAcknowledgement, mood],
                    );
                    res.json({
                      reply: aiReply,
                      mood: mood,
                      planUpdated: planUpdated,
                    });
                  } catch (e) {
                    console.error("AI Generation Error:", e);
                    res.status(500).json({ error: "AI failed to respond." });
                  }
                },
              ); // End niggles fetch
            },
          ); // End activities fetch
        },
      ); // End metrics fetch
    },
  );
});

module.exports = router;
