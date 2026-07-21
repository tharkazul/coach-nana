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

router.post("/api/user/cycle/log", authenticateToken, (req, res) => {
  const { cycleStartDate } = req.body;
  db.run(
    `UPDATE users SET last_cycle_start = ? WHERE id = ?`,
    [cycleStartDate, req.user.id],
    function (err) {
      if (err)
        return res.status(500).json({ error: "Failed to log cycle start." });
      res.json({ message: "Cycle logged successfully!" });
    },
  );
});

router.post("/api/weight", authenticateToken, (req, res) => {
  const { date, weight_kg, body_fat_percent, bmi, lean_mass_kg } = req.body;

  if (!weight_kg) return res.status(400).json({ error: "Weight is required." });

  db.run(
    `INSERT INTO biometrics (user_id, date, weight_kg, body_fat_percent, bmi, lean_mass_kg) 
         VALUES (?, ?, ?, ?, ?, ?) 
         ON CONFLICT(user_id, date) 
         DO UPDATE SET weight_kg=excluded.weight_kg, body_fat_percent=excluded.body_fat_percent, bmi=excluded.bmi, lean_mass_kg=excluded.lean_mass_kg`,
    [
      req.user.id,
      date,
      weight_kg,
      body_fat_percent || null,
      bmi || null,
      lean_mass_kg || null,
    ],
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to log weight." });
      res.json({ success: true });
    },
  );
});

router.get("/api/niggles/active", authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM athlete_niggles WHERE user_id = ? AND status = 'active'`,
    [req.user.id],
    (err, rows) => {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to fetch active niggles." });
      res.json(rows);
    },
  );
});

router.post("/api/niggles", authenticateToken, (req, res) => {
  const { body_part, severity, notes } = req.body;
  if (!body_part || !severity)
    return res
      .status(400)
      .json({ error: "Body part and severity are required." });

  db.get(
    `SELECT id FROM athlete_niggles WHERE user_id = ? AND body_part = ? AND status = 'active'`,
    [req.user.id, body_part],
    (err, row) => {
      if (err) return res.status(500).json({ error: "Database error." });

      if (row) {
        // Update existing active niggle
        db.run(
          `UPDATE athlete_niggles SET severity = ?, notes = ? WHERE id = ?`,
          [severity, notes || "", row.id],
          (updateErr) => {
            if (updateErr)
              return res
                .status(500)
                .json({ error: "Failed to update niggle." });
            res.json({ success: true });
          },
        );
      } else {
        // Insert new niggle
        db.run(
          `INSERT INTO athlete_niggles (user_id, body_part, severity, notes, status) VALUES (?, ?, ?, ?, 'active')`,
          [req.user.id, body_part, severity, notes || ""],
          (insertErr) => {
            if (insertErr)
              return res.status(500).json({ error: "Failed to log niggle." });
            res.json({ success: true });
          },
        );
      }
    },
  );
});

router.put("/api/niggles/:id/resolve", authenticateToken, (req, res) => {
  const niggleId = req.params.id;
  db.run(
    `UPDATE athlete_niggles SET status = 'resolved' WHERE id = ? AND user_id = ?`,
    [niggleId, req.user.id],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to resolve niggle." });
      res.json({ success: true });
    },
  );
});

router.get("/api/physique", authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM physique_logs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50`,
    [req.user.id],
    (err, rows) => {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to fetch physique logs." });
      res.json(rows);
    },
  );
});

router.get("/api/images/physique/:filename", authenticateToken, (req, res) => {
  const filename = req.params.filename;
  if (!filename.startsWith(`physique_${req.user.id}_`)) {
    return res
      .status(403)
      .json({ error: "Forbidden: You do not have access to this image." });
  }
  const filePath = path.join(__dirname, "secure_uploads/physique", filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

router.get("/api/images/chat/:filename", authenticateToken, (req, res) => {
  const filename = req.params.filename;
  if (!filename.startsWith(`img_${req.user.id}_`)) {
    return res
      .status(403)
      .json({ error: "Forbidden: You do not have access to this image." });
  }
  const filePath = path.join(__dirname, "secure_uploads/chat_images", filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

router.post(
  "/api/physique",
  authenticateToken,
  uploadPhysique.single("photo"),
  async (req, res) => {
    const { date, weight_kg, sleep_quality, fatigue_level, notes } = req.body;
    const photoUrl = req.file
      ? `/api/images/physique/${req.file.filename}`
      : null;

    db.run(
      `INSERT INTO physique_logs (user_id, date, weight_kg, sleep_quality, fatigue_level, notes, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        date,
        weight_kg || null,
        sleep_quality || null,
        fatigue_level || null,
        notes || null,
        photoUrl,
      ],
      async function (err) {
        if (err)
          return res
            .status(500)
            .json({ error: "Failed to save physique log." });

        // Also insert weight into biometrics for charting
        if (weight_kg) {
          db.run(
            `INSERT INTO biometrics (user_id, date, weight_kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg=excluded.weight_kg`,
            [req.user.id, date, weight_kg],
          );
        }

        res.json({ success: true });

        // Proactive AI Coach message
        try {
          let prompt = `The athlete just logged their daily physique and wellness data for ${date}.\\n`;
          if (weight_kg) prompt += `Weight: ${weight_kg}kg\\n`;
          if (sleep_quality)
            prompt += `Sleep Quality (1-5): ${sleep_quality}\\n`;
          if (fatigue_level)
            prompt += `Fatigue Level (1-5): ${fatigue_level}\\n`;
          if (notes) prompt += `Notes: ${notes}\\n`;

          let imageBase64 = null;
          if (req.file) {
            prompt += `They also uploaded a progress photo (attached).\\n`;
            const imageBytes = fs.readFileSync(req.file.path);
            imageBase64 = imageBytes.toString("base64");
          }

          db.all(
            `SELECT sport, description, target_spark FROM micro_plan WHERE user_id = ? AND date = ?`,
            [req.user.id, date],
            (err, planRows) => {
              if (planRows && planRows.length > 0) {
                prompt +=
                  `Their planned workouts for today are: ` +
                  planRows
                    .map((r) => `${r.sport} (${r.description})`)
                    .join(", ") +
                  `.\\n`;
              } else {
                prompt += `They have a Rest day planned for today.\\n`;
              }

              prompt += `Review their status. Keep it under 2 sentences, act as their friendly elite endurance coach, and give them a short piece of advice or encouragement based on their numbers (and the photo if attached).`;

              db.get(
                "SELECT coach_tone FROM users WHERE id = ?",
                [req.user.id],
                async (err, row) => {
                  const tone = row ? row.coach_tone : "Friendly";
                  const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${tone}. Act like a real human in a continuous text message thread.`;
                  try {
                    const aiReply = await generateWithFallback(
                      prompt,
                      systemPrompt,
                      null,
                      imageBase64,
                    );
                    db.run(
                      `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`,
                      [req.user.id, aiReply],
                    );
                    sendSSEEvent(req.user.id, "unread_message", {
                      message: aiReply,
                      mood: "support",
                    });
                  } catch (e) {
                    console.error(
                      "Proactive AI generation for physique failed:",
                      e,
                    );
                  }
                },
              );
            },
          );
        } catch (e) {
          console.error("Proactive AI generation for physique failed:", e);
        }
      },
    );
  },
);

router.delete("/api/physique/:id", authenticateToken, (req, res) => {
  // First find the date so we can optionally remove the biometric weight log for that day
  db.get(
    `SELECT date FROM physique_logs WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    (err, row) => {
      if (!row) return res.status(404).json({ error: "Log not found." });

      db.run(
        `DELETE FROM physique_logs WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.id],
        (err) => {
          if (err)
            return res.status(500).json({ error: "Failed to delete log." });

          // Also nullify/remove weight from biometrics for this date if we are deleting the physique log
          // (Assuming weight_kg was the primary entry method for that date)
          db.run(`DELETE FROM biometrics WHERE user_id = ? AND date = ?`, [
            req.user.id,
            row.date,
          ]);

          res.json({ success: true });
        },
      );
    },
  );
});

router.delete("/api/physique/:id", authenticateToken, (req, res) => {
  // First find the date so we can optionally remove the biometric weight log for that day
  db.get(
    `SELECT date FROM physique_logs WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    (err, row) => {
      if (!row) return res.status(404).json({ error: "Log not found." });

      db.run(
        `DELETE FROM physique_logs WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.id],
        (err) => {
          if (err)
            return res.status(500).json({ error: "Failed to delete log." });

          // Also nullify/remove weight from biometrics for this date if we are deleting the physique log
          // (Assuming weight_kg was the primary entry method for that date)
          db.run(`DELETE FROM biometrics WHERE user_id = ? AND date = ?`, [
            req.user.id,
            row.date,
          ]);

          res.json({ success: true });
        },
      );
    },
  );
});

router.get("/api/physique/nutrition", authenticateToken, async (req, res) => {
  const todayStr = new Date().toISOString().split("T")[0];

  db.get(
    `SELECT protocol_json FROM nutrition_protocols WHERE user_id = ? AND date = ?`,
    [req.user.id, todayStr],
    async (err, cachedRow) => {
      if (cachedRow && cachedRow.protocol_json) {
        try {
          return res.json(JSON.parse(cachedRow.protocol_json));
        } catch (e) {
          // Parse error, ignore and regenerate
          console.error("Cache parse error", e);
        }
      }

      db.get(
        `SELECT weight_kg FROM biometrics WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
        [req.user.id],
        async (err, weightRow) => {
          const weight = weightRow ? weightRow.weight_kg : 75; // Default to 75kg if unknown
          const phase = await getUserMacroPhase(req.user.id);

          // Fetch today's completed activities (if any)
          db.all(
            `SELECT SUM(spark_score) as total_score FROM activities WHERE user_id = ? AND date(start_date) = ?`,
            [req.user.id, todayStr],
            (err, actualAct) => {
              const actualSpark =
                actualAct && actualAct.length > 0 && actualAct[0].total_score
                  ? actualAct[0].total_score
                  : 0;

              db.all(
                `SELECT date, target_spark, description FROM micro_plan WHERE user_id = ? AND date = ? LIMIT 1`,
                [req.user.id, todayStr],
                async (err, todayPlan) => {
                  let todaySpark =
                    todayPlan && todayPlan.length > 0
                      ? todayPlan[0].target_spark
                      : 0;
                  let todayDesc =
                    todayPlan && todayPlan.length > 0
                      ? todayPlan[0].description
                      : "Rest day";

                  // If they already trained harder than planned (or trained on a rest day), update the prompt
                  if (
                    actualSpark > todaySpark ||
                    (actualSpark > 0 && todayDesc === "Rest day")
                  ) {
                    todaySpark = actualSpark;
                    todayDesc = "Completed Workout / Training Day";
                  }

                  const systemPrompt = `You are an elite sports nutritionist. The user is an endurance athlete currently in their ${phase} phase.
Their latest weight is ${weight}kg.
Today's training load/plan: ${todayDesc} (Spark Points: ${todaySpark}).

Based on today's training load and their current macro phase, recommend a daily macro nutrition target.
- For high Spark Points / intense days, prescribe higher carbohydrates.
- For rest / low Spark Points days, prescribe lower carbohydrates and higher protein/fat.
- Ensure total calories make sense for an endurance athlete of their weight.

You MUST respond with ONLY a raw JSON object containing exactly these keys:
{
  "title": "String (e.g. 'High Carb / Big Session')",
  "rationale": "String (1-2 sentences explaining why)",
  "carbs": Number (grams),
  "protein": Number (grams),
  "fat": Number (grams)
}`;

                  try {
                    let aiReply = await generateWithFallback(
                      "Generate the macro protocol.",
                      systemPrompt,
                      [],
                    );
                    // Extract JSON between the first { and last } to avoid markdown formatting issues
                    const firstBrace = aiReply.indexOf("{");
                    const lastBrace = aiReply.lastIndexOf("}");
                    if (firstBrace !== -1 && lastBrace !== -1) {
                      aiReply = aiReply.substring(firstBrace, lastBrace + 1);
                    }

                    const protocol = JSON.parse(aiReply);

                    // Cache the result
                    db.run(
                      `INSERT OR REPLACE INTO nutrition_protocols (user_id, date, protocol_json) VALUES (?, ?, ?)`,
                      [req.user.id, todayStr, JSON.stringify(protocol)],
                    );

                    res.json(protocol);
                  } catch (e) {
                    console.error("Nutrition AI failed:", e);
                    // Fallback to a safe baseline if AI fails to parse
                    res.json({
                      title: "Balanced Maintenance",
                      rationale:
                        "AI is currently resting. Here is a balanced baseline protocol for your weight.",
                      carbs: Math.round(weight * 4),
                      protein: Math.round(weight * 1.8),
                      fat: Math.round(weight * 1),
                    });
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

router.get("/api/weight", authenticateToken, (req, res) => {
  db.all(
    `SELECT date, weight_kg, body_fat_percent, bmi, lean_mass_kg 
         FROM biometrics 
         WHERE user_id = ? 
         ORDER BY date ASC`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        console.error("Database error fetching weight:", err);
        return res.status(500).json({ error: "Failed to fetch weight data." });
      }
      res.json(rows || []);
    },
  );
});

module.exports = router;
