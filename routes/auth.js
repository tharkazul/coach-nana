const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../services/db");

// Register a new friend
router.post("/register", async (req, res) => {
  const { username, password, context } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password_hash, athlete_context) VALUES (?, ?, ?)`,
      [username, hashedPassword, context || "New athlete."],
      function (err) {
        if (err)
          return res
            .status(400)
            .json({ error: "Username might already exist." });
        res
          .status(201)
          .json({
            message: "Athlete registered successfully!",
            userId: this.lastID,
          });
      },
    );
  } catch (error) {
    res.status(500).json({ error: "Registration failed." });
  }
});

// Login and get a token
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE username = ?`,
    [username],
    async (err, user) => {
      if (err || !user)
        return res.status(400).json({ error: "Athlete not found." });

      if (await bcrypt.compare(password, user.password_hash)) {
        const token = jwt.sign(
          { id: user.id, username: user.username },
          process.env.JWT_SECRET,
          { expiresIn: "30d" },
        );
        db.run(`UPDATE users SET login_count = login_count + 1 WHERE id = ?`, [
          user.id,
        ]);
        res.json({ token, message: "Welcome to Spark HQ" });
      } else {
        res.status(401).json({ error: "Incorrect password." });
      }
    },
  );
});

module.exports = router;
