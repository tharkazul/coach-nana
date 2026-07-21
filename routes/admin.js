const express = require("express");
const router = express.Router();
const db = require("../services/db");
const { authenticateToken } = require("../services/auth");
const { getUserLeaderboardString } = require("../services/utils");
const { generateWithFallback } = require("../services/ai");
const { sendSSEEvent } = require("../services/sse");

router.post("/api/admin/simulate-24h", authenticateToken, async (req, res) => {
  const user = req.user;
  console.log(`🤖 Simulating 24h inactivity for user ${user.id}...`);

  db.get(
    `SELECT coach_tone FROM users WHERE id = ?`,
    [user.id],
    async (err, row) => {
      const lbString = await getUserLeaderboardString(user.id);
      const prompt = `The user has not logged any activities or sent any messages in over 24 hours. Write a short, proactive message checking in on them and asking how their training is going. Use the tone: ${row ? row.coach_tone : "Friendly and motivating"}. Keep it under 2 sentences. If applicable, playfully use their standing on the leaderboard to motivate them: ${lbString}`;
      try {
        const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${row ? row.coach_tone : "Friendly and motivating"}. Act like a real human in a continuous text message thread.`;
        const aiReply = await generateWithFallback(prompt, systemPrompt);
        db.run(
          `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'curious')`,
          [user.id, aiReply],
        );
        sendSSEEvent(user.id, "unread_message", {
          message: aiReply,
          mood: "curious",
        });
        res.json({ success: true, message: "Trigger fired." });
      } catch (e) {
        console.error("Simulated AI generation failed:", e);
        res.status(500).json({ error: "Failed" });
      }
    },
  );
});

router.get("/api/admin/usage", authenticateToken, (req, res) => {
  const isRutger =
    req.user.username && req.user.username.toLowerCase().includes("rutger");
  const isFelix =
    req.user.username && req.user.username.toLowerCase().includes("felixson");
  if (!isRutger && !isFelix && req.user.id !== 1) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const query = `
        SELECT 
            u.username, 
            u.login_count, 
            u.chat_count,
            u.daily_token_usage,
            CASE WHEN u.strava_refresh_token IS NOT NULL AND u.strava_refresh_token != '' THEN 1 ELSE 0 END as strava_connected,
            CASE WHEN u.garmin_username IS NOT NULL AND u.garmin_username != '' THEN 1 ELSE 0 END as garmin_connected,
            (SELECT COUNT(*) FROM activities WHERE user_id = u.id) as activities_count
        FROM users u
        ORDER BY u.login_count DESC
    `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json(rows || []);
  });
});

module.exports = router;
