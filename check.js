const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_multi.db');
db.all('SELECT * FROM micro_plan', (err, rows) => {
    console.log(JSON.stringify(rows, null, 2));
});
