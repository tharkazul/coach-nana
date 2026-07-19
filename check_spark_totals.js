const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_staging.db'); // Checking if nana_staging.db is the right one, or coach.db, or spark.db. Let's try nana_staging.db first

db.all(`
    SELECT u.username, SUM(a.spark_score) as total_spark
    FROM users u
    LEFT JOIN activities a ON u.id = a.user_id
    GROUP BY u.id
    ORDER BY total_spark DESC
`, (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
    db.close();
});
