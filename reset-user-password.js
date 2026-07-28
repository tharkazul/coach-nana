// reset-user-password.js
const bcrypt = require("bcrypt");
const db = require("./services/db");

const targetUsername = "FelixSon"; // Replace with the user's username
const newPassword = "SparkFelix"; // Replace with the temporary password

async function resetPassword() {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.run(
        `UPDATE users SET password_hash = ? WHERE username = ?`,
        [hashedPassword, targetUsername],
        function (err) {
            if (err) {
                console.error("Error updating password:", err);
            } else if (this.changes === 0) {
                console.log(`User "${targetUsername}" not found.`);
            } else {
                console.log(`Successfully reset password for user "${targetUsername}".`);
            }
            process.exit(0);
        }
    );
}

resetPassword();