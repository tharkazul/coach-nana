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
  evaluateAndProgressQuests,
  calculateQuestProgress
} = require('../services/utils');

function getTimeRemainingStr(expiresAt) {
  if (!expiresAt) return null;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return "Expired";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${remainingHours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

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

router.get("/api/gamification", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const responseData = { quests: [], titles: [], bonus_points: [] };

  try {
    await evaluateAndProgressQuests(userId);
  } catch (e) {
    console.error("Error evaluating quests in /api/gamification:", e);
  }

  // Fix any quest erroneously marked completed after its expiration date
  db.run(
    `UPDATE user_quests SET status = 'expired' WHERE user_id = ? AND expires_at IS NOT NULL AND completed_at > expires_at AND status = 'completed'`,
    [userId]
  );

  // Ensure only 1 active quest per user by closing any older active quests
  db.run(
    `UPDATE user_quests SET status = 'closed' WHERE user_id = ? AND status = 'active' AND id NOT IN (SELECT id FROM (SELECT id FROM user_quests WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1))`,
    [userId, userId],
    () => {
      db.all(
        `SELECT * FROM user_quests WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        async (err, quests) => {
          if (!err && quests) {
            const processedQuests = await Promise.all(
              quests.map(async (q) => {
                const qObj = { ...q };

                // Expiry check
                if (qObj.status === "active" && qObj.expires_at) {
                  const expiresMs = new Date(qObj.expires_at).getTime();
                  if (expiresMs <= Date.now()) {
                    qObj.status = "expired";
                    db.run(`UPDATE user_quests SET status = 'expired' WHERE id = ?`, [qObj.id]);
                  }
                }

                // Calculate progress for active or completed quests
                const currentVal = await calculateQuestProgress(userId, qObj);
                qObj.current_value = currentVal;
                qObj.progress_percent = Math.min(100, Math.round((currentVal / (qObj.target_value || 1)) * 100));
                qObj.time_remaining_str = qObj.status === "active" ? getTimeRemainingStr(qObj.expires_at) : null;

                // Unit string
                if (qObj.target_metric === "distance_km") qObj.unit = "km";
                else if (qObj.target_metric === "moving_time_min") qObj.unit = "min";
                else if (qObj.target_metric === "spark_score") qObj.unit = "pts";
                else qObj.unit = "";

                return qObj;
              })
            );
            responseData.quests = processedQuests;
          }

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
    }
  );
});

router.post(
  "/api/gamification/generate_quest",
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;

    db.get(
      `SELECT count(*) as count FROM user_quests WHERE user_id = ? AND status = 'active'`,
      [userId],
      async (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (row && row.count > 0) {
          return res.status(400).json({ error: "You already have an active quest." });
        }
        
        try {
          const questData = await generateQuestForUser(userId, "common");
          res.json({ success: true, quest: questData });
        } catch (e) {
          console.error("Failed to generate quest:", e);
          res.status(500).json({ error: "Failed to generate quest" });
        }
      }
    );
  },
);

router.post(
  "/api/gamification/refresh_quest",
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;
    const { quest_id } = req.body;

    db.get(
      `SELECT * FROM user_quests WHERE id = ? AND user_id = ? AND status = 'active'`,
      [quest_id, userId],
      async (err, quest) => {
        if (err || !quest) {
          return res.status(404).json({ error: "Active quest not found or already completed." });
        }

        try {
          // Mark old quest as replaced/void
          db.run(`UPDATE user_quests SET status = 'void' WHERE id = ?`, [quest.id]);
          // Generate easier quest using the common token pool
          const newQuest = await generateQuestForUser(userId, "common", quest);
          if (!newQuest) {
            return res.status(500).json({ error: "Failed to generate easier replacement quest" });
          }
          newQuest.current_value = 0;
          res.json({ success: true, quest: newQuest });
        } catch (e) {
          console.error("Failed to refresh quest:", e);
          res.status(500).json({ error: "Failed to generate easier replacement quest" });
        }
      }
    );
  },
);

router.post("/api/gamification/evaluate_quests", authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const allQuests = await evaluateAndProgressQuests(userId);
    const completed = allQuests.filter((q) => q.status === "completed");
    if (completed.length > 0) {
      res.json({
        success: true,
        message: `Evaluated and completed ${completed.length} quests!`,
      });
    } else {
      res.json({
        success: true,
        message: "Evaluated your active quests, but no new targets were reached yet.",
      });
    }
  } catch (e) {
    res.status(500).json({ error: "Failed to evaluate quests." });
  }
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

          // Check if user currently has an active title
          db.get(
            `SELECT COUNT(*) as active_count FROM user_titles WHERE user_id = ? AND is_active = 1`,
            [userId],
            (errCount, countRow) => {
              const shouldBeActive = !errCount && countRow && countRow.active_count === 0 ? 1 : 0;

              db.run(
                `INSERT INTO user_titles (user_id, title, description, is_active) VALUES (?, ?, ?, ?)`,
                [userId, titleData.title, titleData.description, shouldBeActive],
                function (errInsert) {
                  // Also award 50 bonus points for a new title
                  db.run(
                    `INSERT INTO bonus_points (user_id, amount, reason) VALUES (?, ?, ?)`,
                    [userId, 50, `Earned Title: ${titleData.title}`],
                  );

                  // Clear public profile cache so changes reflect on social profile
                  db.run(`DELETE FROM public_profile_cache WHERE user_id = ?`, [userId]);

                  res.json({ success: true, title: { id: this.lastID, ...titleData, is_active: shouldBeActive } });
                }
              );
            }
          );
        } catch (e) {
          console.error("Failed to generate title:", e);
          res.status(500).json({ error: "Failed to generate title" });
        }
      },
    );
  },
);

// Equip / Unequip a title
router.post(
  "/api/titles/:id/equip",
  authenticateToken,
  (req, res) => {
    const userId = req.user.id;
    const titleId = req.params.id;

    db.get(
      `SELECT is_active FROM user_titles WHERE id = ? AND user_id = ?`,
      [titleId, userId],
      (err, titleRow) => {
        if (err || !titleRow) {
          return res.status(44).json({ error: "Title not found" });
        }

        const currentlyActive = titleRow.is_active === 1;

        // Reset all titles for this user to inactive first
        db.run(
          `UPDATE user_titles SET is_active = 0 WHERE user_id = ?`,
          [userId],
          (errReset) => {
            if (errReset) {
              return res.status(500).json({ error: "Failed to update title status" });
            }

            // If it wasn't active before, set it to active now (toggle behavior)
            if (!currentlyActive) {
              db.run(
                `UPDATE user_titles SET is_active = 1 WHERE id = ? AND user_id = ?`,
                [titleId, userId],
                (errEquip) => {
                  db.run(`DELETE FROM public_profile_cache WHERE user_id = ?`, [userId]);
                  res.json({ success: true, equipped: true, activeTitleId: titleId });
                }
              );
            } else {
              db.run(`DELETE FROM public_profile_cache WHERE user_id = ?`, [userId]);
              res.json({ success: true, equipped: false, activeTitleId: null });
            }
          }
        );
      }
    );
  }
);

// Delete a title
router.delete(
  "/api/titles/:id",
  authenticateToken,
  (req, res) => {
    const userId = req.user.id;
    const titleId = req.params.id;

    db.run(
      `DELETE FROM user_titles WHERE id = ? AND user_id = ?`,
      [titleId, userId],
      function (err) {
        if (err) {
          return res.status(500).json({ error: "Failed to delete title" });
        }
        db.run(`DELETE FROM public_profile_cache WHERE user_id = ?`, [userId]);
        res.json({ success: true, deletedId: titleId });
      }
    );
  }
);


module.exports = router;
