const db = require("./db");
const { generateWithFallback } = require("./ai");
const { sendSSEEvent } = require("./sse");

/**
 * Feature Registry: List of trackable Spark features.
 * Easily extensible by adding new items to this array in the future.
 */
const FEATURES_REGISTRY = [
  {
    key: "food_logging",
    name: "Food Log & Macro Intake",
    description: "Track your meals and macros directly by talking to your coach in chat or logging daily intake.",
    coachPrompt: "Did you know you can chat with me about what you ate today? You can just tell me your meals in chat, or log your food, and I'll calculate your daily macro intake (carbs, protein, fat) to keep your energy high for training!",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT ((SELECT COUNT(*) FROM daily_diet_logs WHERE user_id = ?) + (SELECT COUNT(*) FROM nutrition_intake WHERE user_id = ?)) as cnt`,
          [userId, userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "niggle_tracking",
    name: "Niggle & Injury Tracking",
    description: "Log muscle tightness, niggles, or minor pain so your coach can adapt your training workload.",
    coachPrompt: "Keep your body healthy by logging any niggles or tightness you feel! Whenever you report a niggle or pain, I'll take it into consideration and adjust your upcoming workouts to keep you injury-free.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) as cnt FROM athlete_niggles WHERE user_id = ?`,
          [userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "daily_availability",
    name: "Daily Training Availability",
    description: "Set how many hours or which days you can train each week in settings.",
    coachPrompt: "Make sure your training fits your busy schedule! You can set your daily availability in your settings (how many hours you can train on specific days), and I will build your weekly plan around your available time slots.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT training_availability FROM users WHERE id = ?`,
          [userId],
          (err, row) => resolve(row && row.training_availability && row.training_availability.trim() !== '' && row.training_availability !== '{}')
        );
      });
    }
  },
  {
    key: "plan_adaptation",
    name: "Plan Adaptation (Life Happens)",
    description: "Tell your coach when life gets in the way or you miss a workout, and get your plan adapted on the fly.",
    coachPrompt: "Life happens! If you get sick, super busy, or miss a workout, just let me know in chat or request an adaptation. I'll automatically re-balance your week so you stay on target without getting burnt out.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) as cnt FROM chat_history WHERE user_id = ? AND role = 'user' AND (LOWER(content) LIKE '%adapt%' OR LOWER(content) LIKE '%sick%' OR LOWER(content) LIKE '%missed%' OR LOWER(content) LIKE '%busy%')`,
          [userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "auto_generate_week",
    name: "Auto-Generate Weekly Micro-Plan",
    description: "Auto-generate your workouts for the week structured around your CTL and target fitness.",
    coachPrompt: "Want a structured plan for the week ahead? You can auto-generate your upcoming training week with one click or ask me in chat, and I'll craft specific workout sessions optimized for your fitness goals.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) as cnt FROM micro_plan WHERE user_id = ?`,
          [userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "goal_race",
    name: "Goal Race & Target Milestones",
    description: "Enter your target race date and fitness targets to align your long-term season progression.",
    coachPrompt: "Have an upcoming event or goal race? You can add your target race and date under Milestones. Having a target race helps us structure your periodization peak for race day!",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) as cnt FROM milestones WHERE user_id = ?`,
          [userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "physique_log",
    name: "Physique & Biometrics Log",
    description: "Log weight, fatigue, sleep quality, or progress photos to monitor body composition and recovery.",
    coachPrompt: "Track how your body is transforming! You can log your weight, sleep quality, fatigue, or physique photos in the physique tab to help monitor your recovery and body composition changes.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT ((SELECT COUNT(*) FROM physique_logs WHERE user_id = ?) + (SELECT COUNT(*) FROM weight_log WHERE user_id = ?) + (SELECT COUNT(*) FROM biometrics WHERE user_id = ?)) as cnt`,
          [userId, userId, userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "quests_gamification",
    name: "Quests & Spark Points",
    description: "Complete active weekly training quests, earn bonus Spark points, and unlock unique athlete titles.",
    coachPrompt: "Stay motivated with weekly Quests! Check your active quests to earn extra Spark points, track your streak, and unlock special titles as you crush your training milestones.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT COUNT(*) as cnt FROM user_quests WHERE user_id = ?`,
          [userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "activity_sync",
    name: "Garmin & Strava Activity Sync",
    description: "Connect your Garmin Connect or Strava account for automatic activity import and Spark scoring.",
    coachPrompt: "Did you know you can connect your Garmin or Strava account? Once connected, your runs and rides automatically sync to Spark, giving you instant Spark points and training stress analysis.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT ((SELECT COUNT(*) FROM strava_tokens WHERE user_id = ?) + (SELECT COUNT(*) FROM users WHERE id = ? AND garmin_username IS NOT NULL AND garmin_username != '')) as cnt`,
          [userId, userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  },
  {
    key: "social_kudos",
    name: "Social Connections & Kudos",
    description: "Connect with friends on Spark, view the community leaderboard, and give kudos on activities.",
    coachPrompt: "Training is better together! Connect with training partners on Spark, check out the weekly leaderboard, and send kudos to motivate each other on recent activities.",
    checkUsage: (userId) => {
      return new Promise((resolve) => {
        db.get(
          `SELECT ((SELECT COUNT(*) FROM connections WHERE user_id = ? OR friend_id = ?) + (SELECT COUNT(*) FROM kudos WHERE user_id = ?)) as cnt`,
          [userId, userId, userId],
          (err, row) => resolve(row ? row.cnt > 0 : false)
        );
      });
    }
  }
];

/**
 * Checks all features in registry for a user. If used, updates user_feature_onboarding.
 */
async function evaluateUserFeatureUsage(userId) {
  for (const feature of FEATURES_REGISTRY) {
    const isUsed = await feature.checkUsage(userId);
    if (isUsed) {
      db.run(
        `INSERT INTO user_feature_onboarding (user_id, feature_key, status, first_used_at) 
         VALUES (?, ?, 'used', CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, feature_key) DO UPDATE SET 
           status = 'used',
           first_used_at = COALESCE(first_used_at, CURRENT_TIMESTAMP)`,
        [userId, feature.key]
      );
    }
  }
}

/**
 * Finds the next feature in registry that the user has NEVER used AND has NOT been introduced to yet.
 */
async function getNextUnusedFeatureForUser(userId) {
  await evaluateUserFeatureUsage(userId);

  return new Promise((resolve) => {
    db.all(
      `SELECT feature_key, status FROM user_feature_onboarding WHERE user_id = ?`,
      [userId],
      (err, rows) => {
        const onboardingMap = new Map();
        if (!err && rows) {
          rows.forEach((r) => onboardingMap.set(r.feature_key, r.status));
        }

        // Return first feature in registry that has neither status 'used' nor 'introduced'
        for (const feature of FEATURES_REGISTRY) {
          const status = onboardingMap.get(feature.key);
          if (status !== 'used' && status !== 'introduced') {
            return resolve(feature);
          }
        }
        resolve(null);
      }
    );
  });
}

/**
 * Weekly Scheduled Job:
 * Evaluates all users and introduces 1 new feature per week per user if they haven't used it.
 */
async function runWeeklyFeatureOnboardingJob() {
  console.log("🚀 Starting weekly feature onboarding drip check...");

  db.all(`SELECT id, username, coach_tone FROM users`, async (err, users) => {
    if (err || !users) {
      console.error("Error fetching users for onboarding job:", err);
      return;
    }

    for (const user of users) {
      try {
        const nextFeature = await getNextUnusedFeatureForUser(user.id);
        if (!nextFeature) {
          console.log(`[Onboarding Job] User ${user.username} (ID: ${user.id}) has no new features to introduce.`);
          continue;
        }

        console.log(`[Onboarding Job] Introducing "${nextFeature.name}" (${nextFeature.key}) to ${user.username} (ID: ${user.id})`);

        const prompt = `You are the athlete's personal endurance coach. Write a natural, friendly, non-overwhelming chat message introducing a useful feature in Spark that they haven't tried yet.
Feature: ${nextFeature.name}
Core Message Guidance: ${nextFeature.coachPrompt}
Instructions:
- Keep it under 3 sentences.
- Speak directly as their coach in chat.
- Sound enthusiastic, encouraging, and natural (NOT robotic or marketing-heavy).
- DO NOT wrap in JSON.`;

        const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${user.coach_tone || "Empathetic but demanding elite endurance coach."}. Act like a real human coach in a text thread.`;

        let aiReply;
        try {
          aiReply = await generateWithFallback(prompt, systemPrompt);
        } catch (aiErr) {
          console.warn(`[Onboarding Job] AI generation fallback used for feature ${nextFeature.key}:`, aiErr.message);
          aiReply = nextFeature.coachPrompt;
        }

        // Save coach message in chat history
        db.run(
          `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'informative')`,
          [user.id, aiReply],
          (err) => {
            if (err) {
              console.error(`Failed to insert chat history for user ${user.id}:`, err);
              return;
            }

            // Push notification bubble to frontend via SSE
            sendSSEEvent(user.id, "unread_message", {
              message: aiReply,
              mood: "informative"
            });

            // Mark feature as introduced in onboarding table
            db.run(
              `INSERT INTO user_feature_onboarding (user_id, feature_key, status, introduced_at) 
               VALUES (?, ?, 'introduced', CURRENT_TIMESTAMP)
               ON CONFLICT(user_id, feature_key) DO UPDATE SET 
                 status = CASE WHEN status = 'used' THEN 'used' ELSE 'introduced' END,
                 introduced_at = CURRENT_TIMESTAMP`,
              [user.id, nextFeature.key]
            );

            console.log(`✅ Successfully delivered onboarding feature "${nextFeature.key}" to user ${user.username}`);
          }
        );
      } catch (e) {
        console.error(`Error processing onboarding for user ${user.id}:`, e);
      }
    }
  });
}

module.exports = {
  FEATURES_REGISTRY,
  evaluateUserFeatureUsage,
  getNextUnusedFeatureForUser,
  runWeeklyFeatureOnboardingJob
};
