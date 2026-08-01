const db = require('../services/db');

function runRetrospectiveCalculation() {
  console.log('Starting retrospective calculation of first usage dates for all users...');

  db.all('SELECT id, username, spark_start_date, total_spark FROM users', async (err, users) => {
    if (err) {
      console.error('Error fetching users:', err);
      process.exit(1);
    }

    for (const u of users) {
      console.log(`\n--------------------------------------------------`);
      console.log(`Processing User ID ${u.id}: "${u.username}"`);

      // Find earliest interaction across all tables
      const queries = [
        { name: 'chat_history (user)', sql: 'SELECT MIN(timestamp) as m FROM chat_history WHERE user_id = ? AND role = "user"' },
        { name: 'chat_history (any)', sql: 'SELECT MIN(timestamp) as m FROM chat_history WHERE user_id = ?' },
        { name: 'physique_logs', sql: 'SELECT MIN(created_at) as m FROM physique_logs WHERE user_id = ?' },
        { name: 'weight_log', sql: 'SELECT MIN(date) as m FROM weight_log WHERE user_id = ?' },
        { name: 'biometrics', sql: 'SELECT MIN(date) as m FROM biometrics WHERE user_id = ?' },
        { name: 'micro_plan', sql: 'SELECT MIN(date) as m FROM micro_plan WHERE user_id = ?' },
        { name: 'nutrition_intake', sql: 'SELECT MIN(date) as m FROM nutrition_intake WHERE user_id = ?' },
        { name: 'daily_diet_logs', sql: 'SELECT MIN(date) as m FROM daily_diet_logs WHERE user_id = ?' },
        { name: 'user_quests', sql: 'SELECT MIN(created_at) as m FROM user_quests WHERE user_id = ?' },
        { name: 'user_titles', sql: 'SELECT MIN(created_at) as m FROM user_titles WHERE user_id = ?' },
        { name: 'bonus_points', sql: 'SELECT MIN(created_at) as m FROM bonus_points WHERE user_id = ?' },
        { name: 'connections', sql: 'SELECT MIN(created_at) as m FROM connections WHERE user_id = ?' },
        { name: 'athlete_niggles', sql: 'SELECT MIN(reported_date) as m FROM athlete_niggles WHERE user_id = ?' },
      ];

      let earliestDate = null;
      let sourceName = null;

      for (const q of queries) {
        const row = await new Promise((resolve) => db.get(q.sql, [u.id], (e, r) => resolve(r)));
        if (row && row.m) {
          const rawVal = String(row.m).trim();
          // Extract date part (YYYY-MM-DD) or compare timestamps
          const datePart = rawVal.substring(0, 10);
          console.log(`  Found timestamp in ${q.name}: ${rawVal} (Date: ${datePart})`);
          if (!earliestDate || rawVal < earliestDate) {
            earliestDate = rawVal;
            sourceName = q.name;
          }
        }
      }

      // If no user interaction found, check activities or default to current date
      if (!earliestDate) {
        const actRow = await new Promise((resolve) =>
          db.get('SELECT MIN(start_date) as m FROM activities WHERE user_id = ?', [u.id], (e, r) => resolve(r))
        );
        if (actRow && actRow.m) {
          earliestDate = String(actRow.m).trim();
          sourceName = 'activities (fallback)';
          console.log(`  No app interaction found; falling back to earliest activity: ${earliestDate}`);
        } else {
          earliestDate = new Date().toISOString();
          sourceName = 'current timestamp (fallback)';
          console.log(`  No interaction or activity found; setting spark_start_date to current time: ${earliestDate}`);
        }
      }

      const sparkStartDateStr = earliestDate;
      const sparkStartDateDay = earliestDate.substring(0, 10);

      console.log(`=> Determined First Usage Date for ${u.username}: ${sparkStartDateStr} (Source: ${sourceName})`);

      // Update user's spark_start_date
      await new Promise((resolve) =>
        db.run('UPDATE users SET spark_start_date = ? WHERE id = ?', [sparkStartDateStr, u.id], (e) => resolve())
      );

      // Zero out spark_score for historic activities before spark_start_date
      const zeroResult = await new Promise((resolve) =>
        db.run(
          `UPDATE activities SET spark_score = 0 WHERE user_id = ? AND substr(start_date, 1, 10) < ?`,
          [u.id, sparkStartDateDay],
          function (e) {
            resolve(this ? this.changes : 0);
          }
        )
      );
      console.log(`  Zeroed out spark_score for ${zeroResult || 0} historic activities prior to ${sparkStartDateDay}.`);

      // Ensure post-start activities have calculated spark_score if currently null/0
      const postRows = await new Promise((resolve) =>
        db.all(
          `SELECT id, moving_time_min, average_heartrate, tss FROM activities WHERE user_id = ? AND substr(start_date, 1, 10) >= ? AND (spark_score IS NULL OR spark_score = 0)`,
          [u.id, sparkStartDateDay],
          (e, r) => resolve(r || [])
        )
      );

      if (postRows.length > 0) {
        console.log(`  Recalculating spark_score for ${postRows.length} valid post-start activities...`);
        const stmt = db.prepare('UPDATE activities SET spark_score = ? WHERE id = ?');
        for (const row of postRows) {
          let bonus = 0;
          if (row.average_heartrate) {
            if (row.average_heartrate >= 180) bonus = 1.0;
            else if (row.average_heartrate >= 160) bonus = 0.4;
            else if (row.average_heartrate >= 140) bonus = 0.3;
            else if (row.average_heartrate >= 120) bonus = 0.2;
            else if (row.average_heartrate >= 100) bonus = 0.0;
            else if (row.average_heartrate >= 80) bonus = -0.2;
            else bonus = -0.5;
          }
          const baseScore = row.moving_time_min || row.tss || 0;
          const score = baseScore > 0 ? baseScore + baseScore * bonus : (row.tss || 0);
          stmt.run(score, row.id);
        }
        await new Promise((resolve) => stmt.finalize(resolve));
      }

      // Recalculate total_spark for user
      const totalRow = await new Promise((resolve) =>
        db.get(
          `SELECT SUM(spark_score) as total FROM activities WHERE user_id = ? AND substr(start_date, 1, 10) >= ?`,
          [u.id, sparkStartDateDay],
          (e, r) => resolve(r)
        )
      );
      const newTotalSpark = (totalRow && totalRow.total) ? totalRow.total : 0;

      await new Promise((resolve) =>
        db.run('UPDATE users SET total_spark = ? WHERE id = ?', [newTotalSpark, u.id], (e) => resolve())
      );

      console.log(`  Updated total_spark for ${u.username}: old = ${u.total_spark || 0}, new = ${newTotalSpark}`);
    }

    console.log('\n✅ Retrospective calculation completed successfully for all users.');
    setTimeout(() => process.exit(0), 500);
  });
}

runRetrospectiveCalculation();
