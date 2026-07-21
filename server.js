require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const db = require("./services/db");

const app = express();

app.use(bodyParser.json({ limit: "15mb" }));
app.use(express.static("public"));

// Route modules
const authRoutes = require("./routes/auth");
const chatRoutes = require("./routes/chat");
const socialRoutes = require("./routes/social");
const gamificationRoutes = require("./routes/gamification");
const integrationsRoutes = require("./routes/integrations");
const physiqueRoutes = require("./routes/physique");
const activitiesRoutes = require("./routes/activities");

app.use("/", authRoutes);
app.use("/", chatRoutes);
app.use("/", socialRoutes);
app.use("/", gamificationRoutes);
app.use("/", integrationsRoutes);
app.use("/", physiqueRoutes);
app.use("/", activitiesRoutes);

// Utilities and cron jobs
const {
  syncAllStravaUsersOnStartup,
  calculateGlobalMaxStats,
  generateAllPublicProfiles,
} = require("./services/utils");

const { sseClients } = require("./services/sse");

// Startup setup
db.serialize(() => {
  console.log("Database initialized (schema from services/db.js).");
  
  // Sync all Strava users on boot
  syncAllStravaUsersOnStartup();
  
  // Create global leaderboard stats
  calculateGlobalMaxStats();
});

// Periodic Jobs
setInterval(() => {
  // Sync all Strava users every 2 hours
  syncAllStravaUsersOnStartup();
}, 2 * 60 * 60 * 1000);

setInterval(() => {
  // Update Leaderboard Profiles Daily at 3 AM AMS time
  const amsDate = new Date().toLocaleTimeString("en-CA", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
  });
  if (amsDate.startsWith("03:00:")) {
    generateAllPublicProfiles();
  }
}, 60 * 1000);

setInterval(() => {
  // Update Leaderboard Stats every 6 hours
  calculateGlobalMaxStats();
}, 6 * 60 * 60 * 1000);

// SSE Heartbeat (every 30 seconds)
setInterval(() => {
  sseClients.forEach((client) => {
    client.res.write(`:\n\n`); // send a comment to keep connection alive
  });
}, 30000);

// Graceful Shutdown
process.on("SIGINT", () => {
  console.log("Closing database connection...");
  db.close(() => {
    console.log("Database connection closed.");
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
