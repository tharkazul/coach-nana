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

router.get("/api/my-profile", authenticateToken, (req, res) => {
  db.get(
    "SELECT data FROM public_profile_cache WHERE user_id = ?",
    [req.user.id],
    (err, row) => {
      if (err || !row)
        return res.status(404).json({ error: "Profile not generated yet" });
      res.json(JSON.parse(row.data));
    },
  );
});

router.get("/api/social/profile/:id", authenticateToken, (req, res) => {
  const targetUserId = req.params.id;

  db.get(
    `SELECT data FROM public_profile_cache WHERE user_id = ?`,
    [targetUserId],
    async (err, row) => {
      if (row && row.data) {
        return res.json(JSON.parse(row.data));
      } else {
        // Fallback generation if missing
        const globalMaxStats = await calculateGlobalMaxStats();
        const profileData = await generatePublicProfile(
          targetUserId,
          globalMaxStats,
        );
        if (profileData) res.json(profileData);
        else res.status(404).json({ error: "User not found" });
      }
    },
  );
});

router.post("/api/social/search", authenticateToken, (req, res) => {
  const { username } = req.body;
  db.get(
    `SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND id != ? AND search_privacy = 0`,
    [username, req.user.id],
    (err, user) => {
      if (err || !user) return res.json({ found: false });
      db.get(
        `SELECT status FROM connections WHERE user_id = ? AND friend_id = ?`,
        [req.user.id, user.id],
        (err, conn) => {
          res.json({
            found: true,
            user: {
              id: user.id,
              username: user.username,
              status: conn ? conn.status : null,
            },
          });
        },
      );
    },
  );
});

router.post("/api/social/connect", authenticateToken, (req, res) => {
  const { friendId } = req.body;
  db.run(
    `INSERT OR IGNORE INTO connections (user_id, friend_id, status) VALUES (?, ?, 'pending')`,
    [req.user.id, friendId],
    function (err) {
      db.run(
        `INSERT OR IGNORE INTO connections (user_id, friend_id, status) VALUES (?, ?, 'pending_received')`,
        [friendId, req.user.id],
        function (err2) {
          sendSSEEvent(friendId, "connection_request", {
            fromUserId: req.user.id,
            username: req.user.username,
          });
          res.json({ success: true });
        },
      );
    },
  );
});

router.post("/api/social/accept", authenticateToken, (req, res) => {
  const { friendId } = req.body;
  db.run(
    `UPDATE connections SET status = 'accepted' WHERE user_id = ? AND friend_id = ?`,
    [req.user.id, friendId],
    function (err) {
      db.run(
        `UPDATE connections SET status = 'accepted' WHERE user_id = ? AND friend_id = ?`,
        [friendId, req.user.id],
        function (err2) {
          sendSSEEvent(friendId, "connection_accepted", {
            fromUserId: req.user.id,
            username: req.user.username,
          });

          db.get(
            `SELECT coach_tone FROM users WHERE id = ?`,
            [friendId],
            async (err, friendUser) => {
              if (friendUser) {
                const prompt = `The athlete just connected with their friend ${req.user.username} on the app. Send a very short 1-sentence message to the athlete welcoming the new connection and telling them to use the competition as motivation.`;
                const sysPrompt = `You are an elite endurance coach. Your tone is: ${friendUser.coach_tone || "Friendly and motivating"}.`;
                try {
                  const msg = await generateWithFallback(prompt, sysPrompt);
                  db.run(
                    `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`,
                    [friendId, msg],
                  );
                  sendSSEEvent(friendId, "unread_message", {
                    message: msg,
                    mood: "support",
                  });
                } catch (e) {
                  console.error(e);
                }
              }
            },
          );

          res.json({ success: true });
        },
      );
    },
  );
});

router.get("/api/social/connections", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT c.friend_id, c.status, u.username
        FROM connections c
        JOIN users u ON c.friend_id = u.id
        WHERE c.user_id = ?
    `,
    [req.user.id],
    (err, rows) => {
      res.json({ connections: rows || [] });
    },
  );
});

router.get("/api/social/feed", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT a.*, u.username, u.profile_picture_url, u.total_spark,
               (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id) as kudos_count,
               (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id AND k.user_id = ?) as has_kudosed
        FROM activities a
        JOIN users u ON a.user_id = u.id
        WHERE a.user_id = ? OR a.user_id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted')
        ORDER BY a.start_date DESC
        LIMIT 20
    `,
    [req.user.id, req.user.id, req.user.id],
    (err, rows) => {
      if (rows) {
        rows.forEach(
          (r) => (r.spark_level = getSparkLevelInfo(r.total_spark).level),
        );
      }
      res.json({ activities: rows || [] });
    },
  );
});

router.get("/api/social/leaderboard", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT u.id, u.username, u.profile_picture_url, u.total_spark, 
               (COALESCE(SUM(a.spark_score), 0) + COALESCE((SELECT SUM(amount) FROM bonus_points WHERE user_id = u.id AND created_at >= datetime('now', '-7 days')), 0)) as total_spark_score, 
               SUM(a.moving_time_min) as total_minutes, COUNT(a.id) as total_activities
        FROM users u
        LEFT JOIN activities a ON a.user_id = u.id AND a.start_date >= datetime('now', '-7 days')
        WHERE (u.id = ? OR u.id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
        GROUP BY u.id
        ORDER BY total_spark_score DESC
    `,
    [req.user.id, req.user.id],
    (err, rows) => {
      if (rows) {
        rows.forEach(
          (r) => (r.spark_level = getSparkLevelInfo(r.total_spark).level),
        );
      }
      res.json({ leaderboard: rows || [] });
    },
  );
});

router.post("/api/social/kudos", authenticateToken, (req, res) => {
  const { activityId } = req.body;
  db.get(
    `SELECT user_id FROM kudos WHERE activity_id = ? AND user_id = ?`,
    [activityId, req.user.id],
    (err, row) => {
      if (row) {
        db.run(
          `DELETE FROM kudos WHERE activity_id = ? AND user_id = ?`,
          [activityId, req.user.id],
          () => res.json({ success: true, added: false }),
        );
      } else {
        db.run(
          `INSERT INTO kudos (activity_id, user_id) VALUES (?, ?)`,
          [activityId, req.user.id],
          () => {
            db.get(
              `SELECT user_id, name FROM activities WHERE id = ?`,
              [activityId],
              (err, act) => {
                if (act && act.user_id !== req.user.id) {
                  sendSSEEvent(act.user_id, "kudos_received", {
                    activityName: act.name,
                    fromUsername: req.user.username || "Someone",
                  });

                  db.get(
                    `SELECT coach_tone FROM users WHERE id = ?`,
                    [act.user_id],
                    async (err, coachUser) => {
                      if (coachUser) {
                        const prompt = `The athlete just received Kudos (a like) from their friend ${req.user.username || "Someone"} on their activity "${act.name}". Send a very short 1-sentence message to the athlete acknowledging this and hyping them up.`;
                        const sysPrompt = `You are an elite endurance coach. Your tone is: ${coachUser.coach_tone || "Friendly and motivating"}.`;
                        try {
                          const msg = await generateWithFallback(
                            prompt,
                            sysPrompt,
                          );
                          db.run(
                            `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
                            [act.user_id, msg],
                          );
                          sendSSEEvent(act.user_id, "unread_message", {
                            message: msg,
                            mood: "hype",
                          });
                        } catch (e) {
                          console.error(e);
                        }
                      }
                    },
                  );
                }
              },
            );
            res.json({ success: true, added: true });
          },
        );
      }
    },
  );
});

module.exports = router;
