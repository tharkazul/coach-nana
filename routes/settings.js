const express = require("express");
const router = express.Router();
const db = require("../services/db");
const { authenticateToken } = require("../services/auth");
const { getSparkLevelInfo } = require("../services/utils");

router.post("/api/settings/privacy", authenticateToken, (req, res) => {
  const { searchPrivacy } = req.body;
  db.run(
    `UPDATE users SET search_privacy = ? WHERE id = ?`,
    [searchPrivacy ? 1 : 0, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: "DB_ERROR" });
      res.json({ success: true });
    },
  );
});

router.get("/api/user/settings", authenticateToken, (req, res) => {
  db.get(
    `SELECT id, username, strava_refresh_token, garmin_username, coach_tone, athlete_context, gender, last_cycle_start, average_cycle_length, search_privacy, profile_picture_url, training_availability, total_spark, daily_token_usage FROM users WHERE id = ?`,
    [req.user.id],
    (err, row) => {
      if (err || !row) return res.status(500).json({ error: "DB Error" });
      let availability = {};
      if (row.training_availability) {
        try {
          availability = JSON.parse(row.training_availability);
        } catch (e) {}
      }
      const sparkLevelInfo = getSparkLevelInfo(row.total_spark);
      res.json({
        id: row.id,
        username: row.username,
        hasStrava: !!row.strava_refresh_token,
        hasGarmin: !!row.garmin_username,
        garminUsername: row.garmin_username,
        coachTone: row.coach_tone,
        athleteContext: row.athlete_context,
        gender: row.gender,
        lastCycleStart: row.last_cycle_start,
        averageCycleLength: row.average_cycle_length || 28,
        searchPrivacy: row.search_privacy === 1,
        profilePictureUrl: row.profile_picture_url,
        trainingAvailability: availability,
        sparkLevel: sparkLevelInfo,
        dailyTokenUsage: row.daily_token_usage || 0,
      });
    },
  );
});

router.post("/api/user/settings/coach", authenticateToken, (req, res) => {
  const {
    coachTone,
    athleteContext,
    gender,
    lastCycleStart,
    trainingAvailability,
  } = req.body;
  const availabilityStr = trainingAvailability
    ? JSON.stringify(trainingAvailability)
    : "{}";

  db.run(
    `UPDATE users SET coach_tone = ?, athlete_context = ?, gender = ?, last_cycle_start = ?, training_availability = ? WHERE id = ?`,
    [
      coachTone,
      athleteContext,
      gender || "Prefer not to say",
      lastCycleStart || null,
      availabilityStr,
      req.user.id,
    ],
    function (err) {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to update coach settings." });
      res.json({ message: "Coach updated successfully!" });
    },
  );
});

router.post('/api/track-spark-plus-click', authenticateToken, (req, res) => {
    db.run(
        `UPDATE users SET spark_plus_clicks = COALESCE(spark_plus_clicks, 0) + 1 WHERE id = ?`,
        [req.user.id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true });
        }
    );
});

module.exports = router;
