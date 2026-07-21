const express = require('express');
const router = express.Router();
const db = require('../services/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const physiqueStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../secure_uploads/physique");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `physique_${req.user.id}_${crypto.randomUUID()}${ext}`);
  },
});
const uploadPhysique = multer({ storage: physiqueStorage });

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../public/uploads/profiles");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
  },
});
const uploadProfile = multer({ storage: profileStorage });
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

router.get("/api/events", authenticateToken, (req, res) => {
  const userId = req.user.id;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx/Cloudflare buffering if applicable

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

  // Store the client
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  const clients = sseClients.get(userId);
  clients.add(res);

  // Send a heartbeat ping every 30 seconds to keep connection alive (prevents Cloudflare QUIC timeout)
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Remove client when connection closes
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(userId);
    }
  });
});

router.get("/api/chat/history", authenticateToken, (req, res) => {
  db.all(
    `SELECT role, content, mood, timestamp, image_path FROM chat_history WHERE user_id = ? ORDER BY id ASC`,
    [req.user.id],
    (err, rows) => {
      if (err)
        return res.status(500).json({ error: "Failed to load chat history." });
      res.json(rows || []);
    },
  );
});

router.post("/api/chat", authenticateToken, async (req, res) => {
  const { message, imageBase64 } = req.body;
  db.run(`UPDATE users SET chat_count = chat_count + 1 WHERE id = ?`, [
    req.user.id,
  ]);

  let imagePathDB = null;
  let base64Data = null;

  if (imageBase64) {
    try {
      // imageBase64 is expected to look like "data:image/jpeg;base64,/9j/4AAQSk..."
      const matches = imageBase64.match(
        /^data:image\/([A-Za-z-+\/]+);base64,(.+)$/,
      );
      if (matches && matches.length === 3) {
        const ext = matches[1];
        base64Data = matches[2];
        const fileName = `img_${req.user.id}_${crypto.randomUUID()}.${ext}`;
        const dir = path.join(__dirname, "secure_uploads/chat_images");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const savePath = path.join(dir, fileName);
        fs.writeFileSync(savePath, base64Data, "base64");
        imagePathDB = `/api/images/chat/${fileName}`;
      }
    } catch (e) {
      console.error("Image saving error:", e);
    }
  }

  db.get(
    `SELECT coach_tone, athlete_context, gender, long_term_memory, daily_token_usage, last_token_reset_date FROM users WHERE id = ?`,
    [req.user.id],
    async (err, user) => {
      if (err) {
        console.error("DB Error fetching user context:", err);
        return res
          .status(500)
          .json({ error: "Failed to load athlete context." });
      }
      if (!user) {
        return res.status(500).json({ error: "Athlete context not found." });
      }

      // Token limit logic
      const todayStr = new Date().toISOString().split("T")[0];
      let currentDailyUsage = user.daily_token_usage || 0;

      if (user.last_token_reset_date !== todayStr) {
        currentDailyUsage = 0;
        db.run(
          `UPDATE users SET daily_token_usage = 0, last_token_reset_date = ? WHERE id = ?`,
          [todayStr, req.user.id],
        );
      }

      if (currentDailyUsage > 100000) {
        return res
          .status(429)
          .json({
            error: "Daily token limit reached. Please try again tomorrow!",
          });
      }

      db.all(
        `SELECT metric, value FROM athlete_metrics WHERE user_id = ?`,
        [req.user.id],
        async (err, metricsRows) => {
          const metricsText =
            metricsRows && metricsRows.length > 0
              ? metricsRows.map((m) => `${m.metric}: ${m.value}`).join(", ")
              : "None explicitly recorded yet.";

          const phase = await getUserMacroPhase(req.user.id);
          try {
            db.all(
              `SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`,
              [req.user.id],
              async (err, recentActivities) => {
                const recentActivitiesText =
                  recentActivities && recentActivities.length > 0
                    ? recentActivities
                        .map(
                          (a) =>
                            `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${Math.round(a.spark_score || 0)} Spark`,
                        )
                        .join("\n                    ")
                    : "No recent activities recorded.";

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

                    const todayStr = getAMSDateString();
                    db.all(
                      `SELECT * FROM micro_plan WHERE user_id = ? AND date >= ? ORDER BY date ASC LIMIT 14`,
                      [req.user.id, todayStr],
                      async (err, planRows) => {
                        const planText =
                          planRows && planRows.length > 0
                            ? planRows
                                .map(
                                  (p) =>
                                    `- ${p.date}: ${p.sport} - ${p.description} (${p.target_spark || p.target_tss || 0} Spark)`,
                                )
                                .join("\n                    ")
                            : "No upcoming workouts scheduled.";

                        db.all(
                          `SELECT name, date, target_ctl FROM milestones WHERE user_id = ? AND date >= ? ORDER BY date ASC LIMIT 3`,
                          [req.user.id, todayStr],
                          async (err, milestoneRows) => {
                            const milestonesText =
                              milestoneRows && milestoneRows.length > 0
                                ? milestoneRows
                                    .map(
                                      (m) =>
                                        `- ${m.date}: ${m.name} (Target CTL: ${m.target_ctl})`,
                                    )
                                    .join("\n                    ")
                                : "No upcoming events/milestones.";

                            db.all(
                              `SELECT body_part, severity, notes FROM athlete_niggles WHERE user_id = ? AND status = 'active'`,
                              [req.user.id],
                              async (err, niggleRows) => {
                                let nigglesText =
                                  "No active injuries or niggles reported.";
                                if (niggleRows && niggleRows.length > 0) {
                                  nigglesText = niggleRows
                                    .map(
                                      (n) =>
                                        `- ${n.body_part}: Severity ${n.severity}/5. ${n.notes || ""}`,
                                    )
                                    .join("\n                    ");
                                }

                                db.all(
                                  `SELECT role, content FROM (SELECT * FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 6) ORDER BY id ASC`,
                                  [req.user.id],
                                  async (err, historyRows) => {
                                    try {
                                      let cleanHistory = [];

                                      (historyRows || []).forEach((row) => {
                                        let currentRole =
                                          row.role === "coach"
                                            ? "model"
                                            : "user";

                                        if (
                                          cleanHistory.length > 0 &&
                                          cleanHistory[cleanHistory.length - 1]
                                            .role === currentRole
                                        ) {
                                          cleanHistory[
                                            cleanHistory.length - 1
                                          ].parts[0].text +=
                                            "\n\n" + row.content;
                                        } else {
                                          cleanHistory.push({
                                            role: currentRole,
                                            parts: [{ text: row.content }],
                                          });
                                        }
                                      });

                                      if (
                                        cleanHistory.length > 0 &&
                                        cleanHistory[0].role !== "user"
                                      ) {
                                        cleanHistory.shift();
                                      }
                                      if (
                                        cleanHistory.length > 0 &&
                                        cleanHistory[cleanHistory.length - 1]
                                          .role === "user"
                                      ) {
                                        cleanHistory.pop();
                                      }

                                      const todayStr = getAMSDateString();
                                      const next7Days = Array.from(
                                        { length: 7 },
                                        (_, i) => {
                                          const d = new Date();
                                          d.setDate(d.getDate() + i);
                                          return `${getAMSWeekday(d)}: ${getAMSDateString(d)}`;
                                        },
                                      ).join(", ");

                                      const gamification =
                                        await getUserGamificationContext(
                                          req.user.id,
                                        );

                                      const systemPrompt = `You are a real, highly experienced endurance coach sending text messages to an athlete.
                    Name coach: Spark
                    Tone: ${user.coach_tone}
                    Current Training Phase: ${phase || user.training_phase || "Base/General"}
                    
                    TIME CONTEXT:
                    Today is ${todayStr}.
                    The upcoming week mapping is:
                    ${next7Days}
                    
                    ${await getWeatherContext()}
                    
                    ATHLETE CONTEXT:
                    Gender: ${user.gender || "Prefer not to say"}
                    ${user.athlete_context}
                    
                    ${user.gender === "Female" ? "IMPORTANT FOR FEMALE ATHLETES: Proactively ask when her menstrual cycle starts to optimize training. Track these dates in your long term memory. Suggest and distribute exercises carefully, reducing physical demand during the strenuous days of the cycle." : ""}

                    LONG-TERM MEMORY (From Past Conversations):
                    ${user.long_term_memory}

                    PHYSIOLOGICAL METRICS:
                    ${metricsText}
                    
                    UPCOMING EVENTS/MILESTONES:
                    ${milestonesText}

                    UPCOMING SCHEDULED WORKOUTS (Microplan):
                    ${planText}
                    
                    RECENT COMPLETED WORKOUTS (For context):
                    ${recentActivitiesText}

                    RECENT STRENGTH & PB HISTORY:
                    ${recentSetsText}
                    
                    ACTIVE INJURIES / NIGGLES:
                    ${nigglesText}

                    PHASE GUIDANCE:
                    - If phase is BASE: Focus on aerobic volume and consistency. Discourage racing or excessive intensity.
                    - If phase is BUILD: Focus on progressing their threshold and VO2max intervals. Tell them it's time to push.
                    - If phase is PEAK: Focus on race-specific intensity and sharpening. Keep them focused on executing race pace perfectly.
                    - If phase is TAPER: Focus heavily on recovery and shedding fatigue. Ensure they rest up for the race.

                    CRITICAL RULES:
                    0. ACTIVITY TYPE (SPORT): The 'sport' field is REQUIRED for every workout in the JSON and MUST be exactly one of: 'Run', 'Bike', 'Swim', 'Strength', 'Rest'. Never leave it blank. For Strength workouts, you MUST include an "exerciseName" in each step.
                    1. Act like a real human in a continuous text message thread: keep your responses concise, focused, and natural.
                    2. NEVER repeat your previous greetings, praises, or paragraphs verbatim. Do not bring up old topics unless the athlete explicitly mentions them.
                    3. Always use metric measurements exclusively (meters for distance, km/h for speed, min/km for pace). Never use imperial units.
                    4. Respond directly with your conversational text. Do not wrap your main reply in JSON.
                    5. INJURY GUARDRAILS: The athlete has active injuries listed above. You MUST alter the training plan and your advice based on this data to prevent further injury.
                       - If an injury is Lower Body (Severity 3+): Strictly avoid high-impact running. Substitute required aerobic load with swimming or indoor cycling.
                       - If an injury affects Grip/Hands: Substitute swimming or heavy upper-body strength with running or indoor cycling.
                       - If Severity is 5: Schedule complete rest for the affected area.
                       - Whenever you modify a plan due to an active injury, explain the substitution to the athlete.
                    5. BRICK WORKOUTS: If you prescribe a multi-sport Brick workout (e.g., Bike + Run), you MUST create two separate objects in the JSON array (one for "Bike", one for "Run") for that same date.
                    6. INTERVALS: To create a repeating block (e.g., 8x 3min fast, 1min rest), use a "repeat" object in steps_json with "iterations" and an array of "steps".
                    7. SENTIMENT & SUPPORT: Pay close attention to the athlete's physical and mental state. If they mention soreness, exhaustion, poor sleep, or lack of motivation, immediately prioritize empathy and recovery. Strongly advise them to rest or dial back intensity, even if it means modifying the plan.
                    8. STRENGTH TRAINING: Only prescribe 'Strength' workouts if the Athlete Context explicitly mentions strength training, weightlifting, or being a hybrid athlete. For Strength workouts, YOU MUST put the individual exercises into the 'steps_json' array, NOT in the 'details' text! Use "condition_type": "reps" instead of time for the interval steps. Set "condition_value" to the number of reps. Add "weight": <kg_number> and "exerciseName": "<name>" to the step object. Use simple, standard exercise names (e.g., "Barbell Back Squat", "Dumbbell Lunge"). Between sets, use a "rest" step with "condition_type": "time_sec" and set "condition_value" to the number of SECONDS to rest (e.g., 90 for 90 seconds). Reference the Athlete Context for their past weights, and try to prescribe slight progressive overload (e.g., +2.5kg).
                    9. TARGETS: If a workout requires a specific pace (e.g. "4:15 min/km") or power (e.g. "250W") instead of a generic zone, add a "target_value" string to the step object (e.g., "target_value": "4:15 min/km"). Otherwise, continue using "zone": <number>.
                    10. PREDICTIVE LOGISTICS: If the WEATHER ALERT is active and the user agrees to move an outdoor workout (Bike/Run) indoors, use the JSON block to update their microplan (e.g. changing 'Bike' to 'Zwift' or 'Run' to 'Treadmill').
                    11. GAMIFICATION (CRITICAL):
                        - The athlete's current activity streak is: ${gamification.streak} days.
                        - The athlete has earned a total of ${gamification.bonusPoints} bonus spark points.
                        - The athlete's latest earned title/badge is: "${gamification.latestTitle}".
                        - Mention their streak or title occasionally to motivate them, especially if their streak is high (e.g., "You're on a ${gamification.streak} day streak, keep the momentum going!"). Do NOT mention it every single time.

                    WORKOUT PLANNING (CRITICAL):
                    If you create, suggest, or modify a workout plan, you MUST append a JSON code block at the very end of your response. 
                    - To CANCEL or CLEAR a workout for a day, you MUST include that date in the JSON array and set "sport": "Rest". Otherwise, the old workout will remain in the database!
                    The JSON must be a valid Array of objects. Format it EXACTLY like this inside triple backticks:
                    \`\`\`json
                    [
                      {
                        "date": "YYYY-MM-DD",
                        "sport": "Run", 
                        "description": "5k Speed Intervals",
                        "target_spark": 80,
                        "details": "Push hard on the intervals, recover fully on the rests.",
                        "steps_json": "[{\\"type\\": \\"warmup\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 15, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}, {\\"type\\": \\"repeat\\", \\"iterations\\": 8, \\"steps\\": [{\\"type\\": \\"interval\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 3, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 4}, {\\"type\\": \\"rest\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 1, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]}, {\\"type\\": \\"cooldown\\", \\"condition_type\\": \\"time\\", \\"condition_value\\": 10, \\"target_type\\": \\"heart.rate.zone\\", \\"zone\\": 1}]"
                      },
                      {
                        "date": "YYYY-MM-DD",
                        "sport": "Rest", 
                        "description": "Active Recovery",
                        "target_spark": 0,
                        "details": "Take the day off.",
                        "steps_json": "[]"
                      }
                    ]
                    \`\`\`
                    *Note: Ensure "steps_json" is formatted as a stringified JSON array as shown in the examples. Exercises MUST go in steps_json, NOT details!*
                    
                    IMAGE GENERATION (NEW):
                    If the athlete asks for an illustration, visualization, diagram, or picture of an exercise, route, pose, or anything else, you can seamlessly generate an image by outputting a Markdown image tag with the following URL format:
                    \`![Description of Image](https://image.pollinations.ai/prompt/{URL_ENCODED_PROMPT}?nologo=true)\`
                    Replace {URL_ENCODED_PROMPT} with a highly detailed, descriptive prompt for an image generation model. Always include '?nologo=true'. The app will automatically render this image!

                    ATHLETE METRICS MEMORY (CRITICAL):
                    If the athlete mentions a new personal best, physiological metric, or baseline number (e.g., FTP, 5K pace, Max HR, resting heart rate, swim threshold), you MUST output an additional JSON block at the very end of your response to commit it to your long-term memory. Format it exactly like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "metrics",
                      "data": {
                        "FTP": "285W",
                        "5K Pace": "4:05 min/km"
                      }
                    }
                    \`\`\`
                    
                    MANUAL ACTIVITY LOGGING:
                    If the athlete manually tells you they completed a workout that hasn't synced from Strava (e.g. they say "I just ran 5k in 25 mins" or "Did a 45 min gym session"), you MUST log it by outputting an additional JSON block at the very end of your response. Format it exactly like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "log_activity",
                      "data": {
                        "name": "Gym Workout",
                        "sport_type": "Strength",
                        "distance_km": 0,
                        "moving_time_min": 30,
                        "spark_score": 25
                      }
                    }
                    \`\`\`

                    MENSTRUAL CYCLE LOGGING (CRITICAL FOR FEMALES):
                    If the athlete mentions that their period/menstrual cycle started today or on a specific date, you MUST update the cycle tracking system by outputting an additional JSON block. Format it exactly like this inside triple backticks:
                    \`\`\`json
                    {
                      "type": "log_cycle",
                      "data": {
                        "start_date": "YYYY-MM-DD"
                      }
                    }
                    \`\`\``;

                                      let aiReply = await generateWithFallback(
                                        message,
                                        systemPrompt,
                                        cleanHistory,
                                        base64Data,
                                        req.user.id,
                                      );
                                      let planUpdated = false;

                                      const jsonMatches = [
                                        ...aiReply.matchAll(
                                          /```json\n?([\s\S]*?)```/gi,
                                        ),
                                      ];
                                      for (const match of jsonMatches) {
                                        try {
                                          const parsedData = JSON.parse(
                                            match[1],
                                          );

                                          if (Array.isArray(parsedData)) {
                                            const planData = parsedData;
                                            const affectedDates = [
                                              ...new Set(
                                                planData.map((day) => day.date),
                                              ),
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
                                          } else if (
                                            parsedData &&
                                            parsedData.type === "metrics" &&
                                            parsedData.data
                                          ) {
                                            const stmt = db.prepare(
                                              `INSERT INTO athlete_metrics (user_id, metric, value) VALUES (?, ?, ?) ON CONFLICT(user_id, metric) DO UPDATE SET value=excluded.value`,
                                            );
                                            for (const [
                                              key,
                                              val,
                                            ] of Object.entries(
                                              parsedData.data,
                                            )) {
                                              stmt.run(
                                                req.user.id,
                                                key,
                                                String(val),
                                              );
                                            }
                                            stmt.finalize();
                                          } else if (
                                            parsedData &&
                                            parsedData.type === "log_cycle" &&
                                            parsedData.data &&
                                            parsedData.data.start_date
                                          ) {
                                            const startDate =
                                              parsedData.data.start_date;
                                            db.run(
                                              `UPDATE users SET last_cycle_start = ? WHERE id = ?`,
                                              [startDate, req.user.id],
                                              (err) => {
                                                if (err)
                                                  console.error(
                                                    "Failed to update cycle start date from chat:",
                                                    err,
                                                  );
                                              },
                                            );
                                            planUpdated = true; // Signal frontend to reload settings/dashboard
                                          } else if (
                                            parsedData &&
                                            parsedData.type ===
                                              "log_activity" &&
                                            parsedData.data
                                          ) {
                                            const act = parsedData.data;
                                            // Use negative ID to avoid collision with real Strava IDs
                                            const manualId = -Date.now();
                                            const startDate =
                                              new Date().toISOString();
                                            const sparkScore =
                                              act.spark_score ||
                                              calculateSparkScore(
                                                act.moving_time_min,
                                                act.average_heartrate,
                                              );

                                            // QUEST EVALUATION
                                            try {
                                              const completedQuests =
                                                await evaluateQuestsAgainstActivity(
                                                  req.user.id,
                                                  {
                                                    distance_km:
                                                      act.distance_km || 0,
                                                    moving_time_min:
                                                      act.moving_time_min || 0,
                                                    spark_score: sparkScore,
                                                  },
                                                );

                                              if (
                                                completedQuests &&
                                                completedQuests.length > 0
                                              ) {
                                                const newQuest =
                                                  await generateQuestForUser(
                                                    req.user.id,
                                                  );
                                                let appendPrompt = `The user just manually logged an activity and ALSO completed their active quest: "${completedQuests[0].description}" earning ${completedQuests[0].reward_points} Spark points! `;
                                                if (newQuest) {
                                                  appendPrompt += `I (the system) have assigned them a NEW quest: "${newQuest.description}". Give a short 1-2 sentence highly motivating response celebrating their completed quest and announcing their new quest!`;
                                                } else {
                                                  appendPrompt += `Give a short 1-2 sentence motivating response celebrating their completed quest!`;
                                                }
                                                const coachAddendum =
                                                  await generateWithFallback(
                                                    appendPrompt,
                                                    "You are a motivating elite coach.",
                                                  );
                                                aiReply +=
                                                  "\n\n" + coachAddendum;
                                              }
                                            } catch (e) {
                                              console.error(
                                                "Quest evaluation failed during manual sync:",
                                                e,
                                              );
                                            }

                                            db.run(
                                              `INSERT INTO activities (id, user_id, name, sport_type, distance_km, moving_time_min, start_date, spark_score, sets_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                              [
                                                manualId,
                                                req.user.id,
                                                act.name || "Manual Workout",
                                                act.sport_type || "Workout",
                                                act.distance_km || 0,
                                                act.moving_time_min || 0,
                                                startDate,
                                                sparkScore,
                                                JSON.stringify(act.sets || []),
                                              ],
                                              (err) => {
                                                if (err)
                                                  console.error(
                                                    "Failed to insert manual activity:",
                                                    err,
                                                  );
                                                else {
                                                  updateUserSparkAndCheckLevel(
                                                    req.user.id,
                                                  );
                                                  // Invalidate today's nutrition cache so it incorporates the new workout
                                                  const todayStr =
                                                    startDate.split("T")[0];
                                                  db.run(
                                                    `DELETE FROM nutrition_protocols WHERE user_id = ? AND date = ?`,
                                                    [req.user.id, todayStr],
                                                  );
                                                }
                                              },
                                            );
                                            planUpdated = true; // Signal frontend to reload data/charts
                                          }
                                        } catch (e) {
                                          console.error(
                                            "Failed to parse an AI JSON block",
                                            e,
                                          );
                                        }
                                      }

                                      aiReply = aiReply
                                        .replace(/```json[\s\S]*?```/gi, "")
                                        .trim();

                                      let mood = "default";
                                      const lowerReply = aiReply.toLowerCase();

                                      // if (lowerReply.includes('crush') || lowerReply.includes('!')) mood = 'hype';
                                      // if (lowerReply.includes('disappoint') || lowerReply.includes('skip')) mood = 'disappointed';

                                      // Define your keyword arrays here
                                      const hypeKeywords = [
                                        "crush",
                                        "!",
                                        "epic",
                                        "beast",
                                        "machine",
                                        "proud",
                                        "smash",
                                        "nailed",
                                        "unstoppable",
                                        "fire",
                                        "stellar",
                                      ];
                                      const disappointedKeywords = [
                                        "disappoint",
                                        "skip",
                                        "excuse",
                                        "slack",
                                        "shortcut",
                                        "off track",
                                        "slipping",
                                        "warning",
                                      ];
                                      const hornyKeywords = [
                                        "horny",
                                        "sexy",
                                        "flirt",
                                        "desire",
                                        "attractive",
                                        "love",
                                        "passion",
                                        "lust",
                                        "dream",
                                        "hot",
                                      ];
                                      // .some() acts as a giant OR statement across the whole array
                                      if (
                                        hypeKeywords.some((word) =>
                                          lowerReply.includes(word),
                                        )
                                      ) {
                                        mood = "hype";
                                      } else if (
                                        hornyKeywords.some((word) =>
                                          lowerReply.includes(word),
                                        )
                                      ) {
                                        mood = "horny";
                                      } else if (
                                        disappointedKeywords.some((word) =>
                                          lowerReply.includes(word),
                                        )
                                      ) {
                                        mood = "disappointed";
                                      }

                                      const simulatedUserMessage = `Can you build my plan for next week, Spark?`;
                                      const coachAcknowledgement = `I've just crunched your latest numbers and pushed a fresh ${phase} phase plan to your dashboard. Go check it out—you're going to crush it!`;

                                      db.run(
                                        `INSERT INTO chat_history (user_id, role, content, image_path) VALUES (?, 'user', ?, ?)`,
                                        [req.user.id, message, imagePathDB],
                                      );
                                      db.run(
                                        `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, ?)`,
                                        [req.user.id, aiReply, mood],
                                      );

                                      db.get(
                                        `SELECT COUNT(*) as count FROM chat_history WHERE user_id = ?`,
                                        [req.user.id],
                                        (err, row) => {
                                          if (
                                            row &&
                                            row.count > 0 &&
                                            row.count % 6 === 0
                                          ) {
                                            triggerBackgroundSummary(
                                              req.user.id,
                                            );
                                          }
                                        },
                                      );

                                      res.json({
                                        reply: aiReply,
                                        mood: mood,
                                        planUpdated: planUpdated,
                                      });
                                    } catch (err) {
                                      console.error("Chat parsing error:", err);
                                      res
                                        .status(500)
                                        .json({
                                          error: "Failed to generate response.",
                                        });
                                    }
                                  },
                                ); // End chat history
                              },
                            ); // End niggles fetch
                          },
                        ); // End milestones
                      },
                    ); // End microplan
                  },
                ); // End recent sets
              },
            ); // End recent activities
          } catch (err) {
            console.error("Error building context:", err);
            res.status(500).json({ error: "Context building failed." });
          }
        },
      ); // End metrics
    },
  ); // End user fetch
});

router.get("/api/chat/briefing", authenticateToken, (req, res) => {
  db.get(
    `SELECT content, mood, timestamp FROM chat_history 
            WHERE user_id = ? AND role = 'coach' AND date(timestamp, 'localtime') = date('now', 'localtime') 
            ORDER BY timestamp ASC LIMIT 1`,
    [req.user.id],
    (err, row) => {
      if (err) {
        console.error("Error fetching briefing:", err);
        return res.status(500).json({ error: "Failed to fetch briefing." });
      }
      res.json({ briefing: row || null });
    },
  );
});

router.post("/api/chat/checkin", authenticateToken, async (req, res) => {
  db.get(
    `SELECT coach_tone, athlete_context, gender FROM users WHERE id = ?`,
    [req.user.id],
    async (err, user) => {
      if (err || !user)
        return res
          .status(500)
          .json({ error: "Failed to load athlete context." });

      db.all(
        `SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 3`,
        [req.user.id],
        async (err, recentActivities) => {
          const recentActivitiesText =
            recentActivities && recentActivities.length > 0
              ? recentActivities
                  .map(
                    (a) =>
                      `- ${getAMSDateString(a.start_date)}: ${a.name} (${a.sport_type}) | ${parseFloat(a.distance_km).toFixed(1)}km | ${Math.round(a.moving_time_min)}min | ${Math.round(a.spark_score || 0)} Spark`,
                  )
                  .join("\n")
              : "No recent activities recorded.";

          db.all(
            `SELECT metric, value FROM athlete_metrics WHERE user_id = ?`,
            [req.user.id],
            async (err, metrics) => {
              const metricsText =
                metrics && metrics.length > 0
                  ? metrics.map((m) => `${m.metric}: ${m.value}`).join(", ")
                  : "No metrics recorded.";

              db.all(
                `SELECT date, sport, description FROM micro_plan WHERE user_id = ? AND date >= date('now') ORDER BY date ASC LIMIT 2`,
                [req.user.id],
                async (err, upcomingPlan) => {
                  const upcomingText =
                    upcomingPlan && upcomingPlan.length > 0
                      ? upcomingPlan
                          .map(
                            (p) => `- ${p.date}: ${p.sport} - ${p.description}`,
                          )
                          .join("\n")
                      : "No upcoming workouts scheduled.";

                  const phase = await getUserMacroPhase(req.user.id);
                  const todayStr = getAMSDateString();
                  const weatherContext = await getWeatherContext();
                  const gamification = await getUserGamificationContext(
                    req.user.id,
                  );
                  let systemPrompt = `You are Spark, an elite Ironman Triathlon and endurance coach.
Today is ${todayStr}.
Athlete Context: ${user.athlete_context || "General endurance athlete"}
Gender: ${user.gender || "Prefer not to say"}
${user.gender === "Female" ? "IMPORTANT: Track menstrual cycle phases and adjust demands based on the physically demanding days of her cycle." : ""}
Key Physiological Metrics:
${metricsText}
Current Macro Phase: ${phase}
Recent Completed Workouts:
${recentActivitiesText}
Upcoming Workouts (Next 2 days):
${upcomingText}
Your Tone & Persona: ${user.coach_tone || "empathetic"}

${weatherContext}

MACRO BLOCK FOCUS RULES:
- If phase is BASE: Focus intensely on keeping their volume high and heart rate low (Zone 2). Discourage speedwork.
- If phase is BUILD: Focus on progressing their threshold and VO2max intervals. Tell them it's time to push.
- If phase is PEAK: Focus on race-specific intensity and sharpening. Keep them focused on executing race pace perfectly.
- If phase is TAPER: Focus heavily on recovery and shedding fatigue. Ensure they rest up for the race.

CRITICAL RULES:
1. Generate a single, highly personalized, proactive 1-2 sentence greeting for the athlete who just opened the app.
2. Analyze their fitness (CTL), fatigue (ATL), and readiness (TSB) from their Key Physiological Metrics. Reference these trends to steer the user towards action (e.g., prioritize recovery if TSB is very negative, or push hard if TSB is positive). You can also reference a recent/upcoming workout.
3. Keep it brief, extremely human, and supportive. 
4. DO NOT generate any JSON or workout plan updates. Just the greeting.
5. PREDICTIVE LOGISTICS: If the WEATHER ALERT is present and the athlete has an outdoor workout (e.g. Bike or Run) scheduled for today, you MUST proactively ask if they want to convert today's outdoor session into an indoor Zwift/treadmill session due to the miserable weather. For example: "Looks miserable out there today. Do you want me to convert today's ride into an indoor Zwift session?"
6. GAMIFICATION: The athlete has a current activity streak of ${gamification.streak} days and has ${gamification.bonusPoints} bonus points. Occasionally mention their streak if it's impressive to hype them up.`;

                  try {
                    let aiReply = await generateWithFallback(
                      "Generate the proactive greeting.",
                      systemPrompt,
                      [],
                    );
                    aiReply = aiReply
                      .replace(/```json[\s\S]*?```/gi, "")
                      .trim();

                    db.run(
                      `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'default')`,
                      [req.user.id, aiReply],
                    );
                    res.json({ reply: aiReply, mood: "default" });
                  } catch (e) {
                    console.error("Checkin Server Error:", e);
                    res.status(500).json({ error: "AI failed to respond." });
                  }
                },
              );
            },
          );
        },
      );
    },
  );
});

module.exports = router;
