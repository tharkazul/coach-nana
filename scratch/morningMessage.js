  sendMorningMessage: async () => {
    console.log("🌞 Running scheduled morning message job...");
    const todayStr = getAMSDateString();
    
    // Find all users who have a workout planned for today
    db.all(
      `SELECT u.id, u.coach_tone FROM users u 
       JOIN micro_plan m ON u.id = m.user_id 
       WHERE m.date = ?`,
      [todayStr],
      async (err, rows) => {
        if (err || !rows) return;
        
        // Remove duplicates if they have multiple workouts today
        const uniqueUsers = [];
        const seen = new Set();
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            uniqueUsers.push(r);
          }
        }

        for (const user of uniqueUsers) {
          try {
            const prompt = `It is morning (${todayStr}). Look at the athlete's planned workouts for today and write a short, proactive, energetic morning message to get them pumped up. Acknowledge their recent work if applicable. Keep it under 3 sentences.`;
            const systemPrompt = `You are Spark, an elite endurance coach. Your tone is: ${user.coach_tone || "Friendly"}. Act like a real human in a continuous text message thread.`;
            
            // Generate the message
            const aiReply = await generateWithFallback(prompt, systemPrompt);
            
            // Insert into history
            db.run(
              `INSERT INTO chat_history (user_id, role, content, mood) VALUES (?, 'coach', ?, 'hype')`,
              [user.id, aiReply]
            );
            
            // Push notification bubble to frontend
            sendSSEEvent(user.id, "unread_message", {
              message: aiReply,
              mood: "hype"
            });
            console.log(`Sent morning message to user ${user.id}`);
          } catch (e) {
            console.error(`Failed to send morning message to user ${user.id}:`, e);
          }
        }
      }
    );
  },
