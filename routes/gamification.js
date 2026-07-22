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

router.get("/api/milestones", authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM milestones WHERE user_id = ? ORDER BY date ASC`,
    [req.user.id],
    (err, rows) => {
      res.json(rows || []);
    },
  );
});

router.post("/api/milestones", authenticateToken, (req, res) => {
  const { milestones } = req.body;

  db.serialize(() => {
    db.run(`DELETE FROM milestones WHERE user_id = ?`, [req.user.id]);

    const stmt = db.prepare(
      `INSERT INTO milestones (user_id, name, date, target_ctl, is_main) VALUES (?, ?, ?, ?, ?)`,
    );
    milestones.forEach((m) => {
      stmt.run(req.user.id, m.name, m.date, m.target_ctl, m.is_main ? 1 : 0);
    });
    stmt.finalize();

    res.json({ success: true, message: "Calendar updated!" });
  });
});

router.get("/api/gamification", authenticateToken, (req, res) => {
  const userId = req.user.id;
  const responseData = { quests: [], titles: [], bonus_points: [] };

  db.all(
    `SELECT * FROM user_quests WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
    (err, quests) => {
      if (!err && quests) responseData.quests = quests;
      db.all(
        `SELECT * FROM user_titles WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, titles) => {
          if (!err && titles) responseData.titles = titles;
          db.all(
            `SELECT * FROM bonus_points WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [userId],
            (err, points) => {
              if (!err && points) responseData.bonus_points = points;
              res.json(responseData);
            },
          );
        },
      );
    },
  );
});

router.post(
  "/api/gamification/generate_quest",
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;

    // Check if user already has an active quest to avoid spamming
    db.get(
      `SELECT count(*) as count FROM user_quests WHERE user_id = ? AND status = 'active'`,
      [userId],
      async (err, row) => {
        if (row && row.count >= 3) {
          return res
            .status(400)
            .json({
              error: "You already have 3 active quests. Complete them first!",
            });
        }

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
            "description": "Short description of the quest (e.g. Run 5k this weekend)",
            "target_metric": "distance_km", // or moving_time_min, etc.
            "target_value": 5,
            "reward_points": 50 // Keep it between 10 and 100
            }`;

            try {
              const aiReply = await generateWithFallback(
                prompt,
                "You are a JSON-only API that outputs valid JSON.",
                null,
                null,
                userId,
                "common"
              );
              const jsonStr = aiReply
                .replace(/\`\`\`json/g, "")
                .replace(/\`\`\`/g, "")
                .trim();
              const questData = JSON.parse(jsonStr);

              db.run(
                `INSERT INTO user_quests (user_id, description, target_metric, target_value, reward_points) VALUES (?, ?, ?, ?, ?)`,
                [
                  userId,
                  questData.description,
                  questData.target_metric,
                  questData.target_value,
                  questData.reward_points,
                ],
              );

              res.json({ success: true, quest: questData });
            } catch (e) {
              console.error("Failed to generate quest:", e);
              res.status(500).json({ error: "Failed to generate quest" });
            }
          },
        );
      },
    );
  },
);

router.post("/api/gamification/evaluate_quests", authenticateToken, (req, res) => {
  const userId = req.user.id;

  // Evaluate the latest activity against active quests
  db.get(
    `SELECT * FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 1`,
    [userId],
    async (err, latestActivity) => {
      if (err || !latestActivity) {
        return res.json({
          success: true,
          message: "No activities found to evaluate against.",
        });
      }

      try {
        const completed = await evaluateQuestsAgainstActivity(
          userId,
          latestActivity,
        );
        if (completed.length > 0) {
          res.json({
            success: true,
            message: `Evaluated and completed ${completed.length} quests based on your latest activity!`,
          });
        } else {
          res.json({
            success: true,
            message:
              "Evaluated your latest activity, but no quests were completed.",
          });
        }
      } catch (e) {
        res.status(500).json({ error: "Failed to evaluate quests." });
      }
    },
  );
});

router.post("/api/gamification/evaluate_quests", authenticateToken, (req, res) => {
  const userId = req.user.id;

  // Evaluate the latest activity against active quests
  db.get(
    `SELECT * FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 1`,
    [userId],
    async (err, latestActivity) => {
      if (err || !latestActivity) {
        return res.json({
          success: true,
          message: "No activities found to evaluate against.",
        });
      }

      try {
        const completed = await evaluateQuestsAgainstActivity(
          userId,
          latestActivity,
        );
        if (completed.length > 0) {
          res.json({
            success: true,
            message: `Evaluated and completed ${completed.length} quests based on your latest activity!`,
          });
        } else {
          res.json({
            success: true,
            message:
              "Evaluated your latest activity, but no quests were completed.",
          });
        }
      } catch (e) {
        res.status(500).json({ error: "Failed to evaluate quests." });
      }
    },
  );
});

router.post(
  "/api/gamification/generate_title",
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;

    db.all(
      `SELECT name, sport_type, distance_km, moving_time_min, spark_score, start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 10`,
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

        const prompt = `Based on the following recent activities, invent a cool, heroic, or funny custom 'Title' or 'Badge' to award the user. 
        For example: "Titan of the Tarmac", "The Weekend Warrior", "Aquaman Protocol".
        Recent activities:
        ${activitiesStr}
        
        Return ONLY a JSON object with this exact structure:
        {
          "title": "The Title Name",
          "description": "A short, funny, or epic description of why they earned it."
        }`;

        try {
          const aiReply = await generateWithFallback(
            prompt,
            "You are a JSON-only API that outputs valid JSON.",
            null,
            null,
            userId,
            "common"
          );
          const jsonStr = aiReply
            .replace(/\`\`\`json/g, "")
            .replace(/\`\`\`/g, "")
            .trim();
          const titleData = JSON.parse(jsonStr);

          db.run(
            `INSERT INTO user_titles (user_id, title, description) VALUES (?, ?, ?)`,
            [userId, titleData.title, titleData.description],
          );

          // Also award 50 bonus points for a new title
          db.run(
            `INSERT INTO bonus_points (user_id, amount, reason) VALUES (?, ?, ?)`,
            [userId, 50, `Earned Title: ${titleData.title}`],
          );

          res.json({ success: true, title: titleData });
        } catch (e) {
          console.error("Failed to generate title:", e);
          res.status(500).json({ error: "Failed to generate title" });
        }
      },
    );
  },
);


module.exports = router;
