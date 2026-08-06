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
    async (err, row) => {
      if (row && row.data) {
        return res.json(JSON.parse(row.data));
      } else {
        try {
          const globalMaxStats = await calculateGlobalMaxStats();
          const profileData = await generatePublicProfile(
            req.user.id,
            globalMaxStats,
          );
          if (profileData) res.json(profileData);
          else res.status(404).json({ error: "Profile not generated yet" });
        } catch (e) {
          console.error("Failed to generate profile for user", req.user.id, e);
          res.status(500).json({ error: "Failed to generate profile" });
        }
      }
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
router.post("/api/social/invite", authenticateToken, (req, res) => {
  console.log("Received invite request:", req.body);
  const { micro_plan_id, invitee_ids, location, time } = req.body;
  if (!micro_plan_id || !invitee_ids || !invitee_ids.length) {
    console.log("Missing fields in invite request");
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Look up the micro_plan item
  db.get(`SELECT * FROM micro_plan WHERE id = ? AND user_id = ?`, [micro_plan_id, req.user.id], (err, plan) => {
    if (err || !plan) {
      console.log("Workout not found in DB. ID:", micro_plan_id, "UserID:", req.user.id, "Err:", err);
      return res.status(404).json({ error: "Workout not found" });
    }

    invitee_ids.forEach(inviteeId => {
      // Create invitation
      db.run(
        `INSERT INTO event_invitations (inviter_id, invitee_id, micro_plan_id, location, time) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, inviteeId, micro_plan_id, location, time],
        function(err) {
          if (err) {
            console.error(err);
            return;
          }
          const inviteId = this.lastID;
          
          // Send Coach Message to invitee
          db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id], (err, inviterUser) => {
            const htmlButtons = `<br><div id="invite-buttons-${inviteId}" class="mt-2 flex gap-2"><button onclick="acceptEvent(${inviteId})" class="bg-theme-accent text-white px-3 py-1 rounded text-xs hover:opacity-90">Accept</button><button onclick="declineEvent(${inviteId})" class="border border-theme-border text-theme-text px-3 py-1 rounded text-xs hover:bg-theme-bg">Decline</button></div>`;
            const inviteeMsg = `Hey! **${req.user.username}** has invited you to join their upcoming **${plan.sport}** workout: **${plan.description || 'Workout'}**.\n\n📅 Date: ${plan.date}\n📍 Location: ${location}\n🕒 Time: ${time}\n\nDo you want to accept this invitation and add it to your plan?${htmlButtons}`;

            db.run(
              `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`,
              [inviteeId, inviteeMsg]
            );
            sendSSEEvent(inviteeId, "unread_message", { message: inviteeMsg, mood: "support" });
          });
        }
      );
    });
    res.json({ success: true });
  });
});

router.get("/api/social/invite/:plan_id", authenticateToken, (req, res) => {
  db.all(`SELECT invitee_id, status FROM event_invitations WHERE micro_plan_id = ? AND inviter_id = ?`, [req.params.plan_id, req.user.id], (err, invites) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ invites: invites || [] });
  });
});

router.post("/api/social/invite/:id/accept", authenticateToken, (req, res) => {
  const inviteId = req.params.id;
  db.get(`SELECT * FROM event_invitations WHERE id = ? AND invitee_id = ?`, [inviteId, req.user.id], (err, invite) => {
    if (err || !invite) return res.status(404).json({ error: "Invite not found" });
    if (invite.status !== 'pending') return res.status(400).json({ error: "Invite already processed" });

    db.run(`UPDATE event_invitations SET status = 'accepted' WHERE id = ?`, [inviteId]);

    db.get(`SELECT id, content FROM chat_history WHERE user_id = ? AND content LIKE ?`, [req.user.id, '%invite-buttons-' + inviteId + '%'], (err, chatRow) => {
        if (chatRow) {
            const newContent = chatRow.content.replace(/<div id="invite-buttons-\d+".*?<\/div>/, `<div id="invite-buttons-${inviteId}" class="mt-2"><span class="bg-theme-bg border border-theme-border text-theme-muted px-3 py-1 rounded text-xs">Accepted</span></div>`);
            db.run(`UPDATE chat_history SET content = ? WHERE id = ?`, [newContent, chatRow.id]);
        }
    });

    // Copy micro_plan
    db.get(`SELECT * FROM micro_plan WHERE id = ?`, [invite.micro_plan_id], (err, plan) => {
      if (plan) {
        db.run(
          `INSERT INTO micro_plan (user_id, date, sport, description, target_spark, details, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, plan.date, plan.sport, plan.description, plan.target_spark, plan.details, plan.steps_json]
        );

        // Notify Inviter
        db.get(`SELECT username FROM users WHERE id = ?`, [req.user.id], (err, acceptor) => {
          const acceptorName = acceptor ? acceptor.username : 'Someone';
          const inviterMsg = `${acceptorName} accepted your invitation for the ${plan.sport} on ${plan.date}!`;
          db.run(
            `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'default')`,
            [invite.inviter_id, inviterMsg]
          );
          sendSSEEvent(invite.inviter_id, "unread_message", { message: inviterMsg, mood: "default" });
        });

        // Trigger background AI check for invitee
        db.all(`SELECT * FROM micro_plan WHERE user_id = ? AND date >= date(?, '-2 days') AND date <= date(?, '+2 days')`, [req.user.id, plan.date, plan.date], async (err, contextPlans) => {
          const sysPrompt = "You are an AI endurance coach. Review this athlete's schedule around an event they just accepted. Keep your response extremely brief (1-2 sentences). If there is a massive conflict (like two heavy workouts on the same day), warn them nicely. If it's fine, just encourage them.";
          const userPrompt = `I just accepted an invite for a ${plan.sport} on ${plan.date}. My surrounding schedule is: ${JSON.stringify(contextPlans)}. Is this okay?`;
          try {
            const aiMsg = await generateWithFallback(userPrompt, sysPrompt);
            db.run(`INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'support')`, [req.user.id, aiMsg]);
            sendSSEEvent(req.user.id, "unread_message", { message: aiMsg, mood: "support" });
          } catch(e) {
            console.error("AI Check Error:", e);
          }
        });
      }
    });

    res.json({ success: true });
  });
});

router.post("/api/social/invite/:id/decline", authenticateToken, (req, res) => {
  const inviteId = req.params.id;
  db.get(`SELECT * FROM event_invitations WHERE id = ? AND invitee_id = ?`, [inviteId, req.user.id], (err, invite) => {
    if (err || !invite) return res.status(404).json({ error: "Invite not found" });
    if (invite.status !== 'pending') return res.status(400).json({ error: "Invite already processed" });

    db.run(`UPDATE event_invitations SET status = 'declined' WHERE id = ?`, [inviteId]);

    db.get(`SELECT id, content FROM chat_history WHERE user_id = ? AND content LIKE ?`, [req.user.id, '%invite-buttons-' + inviteId + '%'], (err, chatRow) => {
        if (chatRow) {
            const newContent = chatRow.content.replace(/<div id="invite-buttons-\d+".*?<\/div>/, `<div id="invite-buttons-${inviteId}" class="mt-2"><span class="bg-theme-bg border border-theme-border text-theme-muted px-3 py-1 rounded text-xs">Declined</span></div>`);
            db.run(`UPDATE chat_history SET content = ? WHERE id = ?`, [newContent, chatRow.id]);
        }
    });

    res.json({ success: true });
  });
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
               (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id AND k.user_id = ?) as has_kudosed,
               (SELECT COUNT(*) FROM activity_comments c WHERE c.activity_id = a.id) as comment_count
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

router.get("/api/social/leaderboard", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Evaluate active quests for the current user and their friends before generating leaderboard
    try {
      const friends = await new Promise((resolve) => {
        db.all(
          `SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'`,
          [userId],
          (err, rows) => resolve(rows || []),
        );
      });
      const userIdsToEvaluate = [userId, ...friends.map((f) => f.friend_id)];
      await Promise.all(userIdsToEvaluate.map((id) => evaluateAndProgressQuests(id)));
    } catch (e) {
      console.error("Error evaluating leaderboard user quests:", e);
    }

    const mainLeaderboard = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT u.id, u.username, u.profile_picture_url, u.total_spark, 
               (COALESCE(SUM(a.spark_score), 0) + COALESCE((SELECT SUM(amount) FROM bonus_points WHERE user_id = u.id AND created_at >= datetime('now', '-7 days')), 0)) as total_spark_score, 
               SUM(a.moving_time_min) as total_minutes, COUNT(a.id) as total_activities,
               COALESCE((SELECT COUNT(*) FROM user_quests WHERE user_id = u.id AND status = 'completed' AND (completed_at >= datetime('now', '-7 days') OR (completed_at IS NULL AND created_at >= datetime('now', '-7 days')))), 0) as quests_completed_7d,
               COALESCE((SELECT SUM(amount) FROM bonus_points WHERE user_id = u.id AND reason LIKE 'Quest Completed%' AND created_at >= datetime('now', '-7 days')), (SELECT SUM(reward_points) FROM user_quests WHERE user_id = u.id AND status = 'completed' AND (completed_at >= datetime('now', '-7 days') OR (completed_at IS NULL AND created_at >= datetime('now', '-7 days')))), 0) as quest_spark_7d
        FROM users u
        LEFT JOIN activities a ON a.user_id = u.id AND a.start_date >= datetime('now', '-7 days') AND (u.spark_start_date IS NULL OR substr(a.start_date, 1, 10) >= substr(u.spark_start_date, 1, 10))
        WHERE (u.id = ? OR u.id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
        GROUP BY u.id
        ORDER BY total_spark_score DESC
    `,
        [userId, userId],
        (err, rows) => {
          if (err) return reject(err);
          if (rows) {
            rows.forEach(
              (r) => (r.spark_level = getSparkLevelInfo(r.total_spark).level),
            );
          }
          resolve(rows || []);
        },
      );
    });

    const completedQuests = await new Promise((resolve) => {
      db.all(
        `
            SELECT id, user_id, description, reward_points, completed_at, created_at
            FROM user_quests
            WHERE status = 'completed'
              AND (completed_at >= datetime('now', '-7 days') OR (completed_at IS NULL AND created_at >= datetime('now', '-7 days')))
              AND (user_id = ? OR user_id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
        `,
        [userId, userId],
        (err, rows) => {
          if (err) return resolve([]);
          resolve(rows || []);
        },
      );
    });

    const questLeaderboard = mainLeaderboard.map((user) => {
      const userQuests = completedQuests.filter((q) => q.user_id === user.id);
      const total_quest_spark = userQuests.reduce((sum, q) => sum + (q.reward_points || 0), 0);
      return {
        id: user.id,
        username: user.username,
        profile_picture_url: user.profile_picture_url,
        spark_level: user.spark_level,
        completed_quests_count: userQuests.length,
        total_quest_spark: Math.round(total_quest_spark),
        quests: userQuests.map((q) => ({ description: q.description, points: q.reward_points })),
      };
    });

    questLeaderboard.sort((a, b) => {
      if (b.completed_quests_count !== a.completed_quests_count) {
        return b.completed_quests_count - a.completed_quests_count;
      }
      if (b.total_quest_spark !== a.total_quest_spark) {
        return b.total_quest_spark - a.total_quest_spark;
      }
      return a.username.localeCompare(b.username);
    });

    const topActivities = await new Promise((resolve) => {
      db.all(
        `
            SELECT a.id, a.user_id, a.name, a.sport_type, a.distance_km, a.moving_time_min, a.spark_score, a.start_date,
                   u.username, u.profile_picture_url, u.total_spark
            FROM activities a
            JOIN users u ON a.user_id = u.id
            WHERE (u.id = ? OR u.id IN (SELECT friend_id FROM connections WHERE user_id = ? AND status = 'accepted'))
              AND a.start_date >= datetime('now', '-7 days') AND (u.spark_start_date IS NULL OR substr(a.start_date, 1, 10) >= substr(u.spark_start_date, 1, 10))
            ORDER BY a.spark_score DESC, a.start_date DESC
            LIMIT 3
        `,
        [userId, userId],
        (err, rows) => {
          if (err) return resolve([]);
          if (rows) {
            rows.forEach(
              (r) => (r.spark_level = getSparkLevelInfo(r.total_spark).level),
            );
          }
          resolve(rows || []);
        },
      );
    });

    res.json({
      leaderboard: mainLeaderboard,
      questLeaderboard,
      topActivities,
    });
  } catch (e) {
    console.error("Error loading full leaderboard data:", e);
    res.status(500).json({ error: "Failed to load leaderboard data." });
  }
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
                            (err) => {
                              if (!err) {
                                sendSSEEvent(act.user_id, "unread_message", {
                                  message: msg,
                                  mood: "hype",
                                });
                              }
                            }
                          );
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
