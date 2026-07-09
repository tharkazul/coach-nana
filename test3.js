const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_multi.db');
db.run("UPDATE micro_plan SET steps_json = '[]' WHERE id = 1", function(err) {
    console.log("Updated rows:", this.changes);
    db.get("SELECT steps_json FROM micro_plan WHERE id = 1", (err, row) => {
        console.log("After update:", row);
    });
});
