const { GarminConnect } = require('@flow-js/garmin-connect');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const db = new sqlite3.Database('./nana_multi.db');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

function decrypt(text) {
    if (!text) return null;
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decipher.final()]);
    return decrypted.toString();
}

db.get(`SELECT garmin_username, garmin_password FROM users WHERE id = 1`, async (err, user) => {
    if (err || !user || !user.garmin_username) {
        console.error("No garmin credentials found.");
        return;
    }
    
    const garmin_password = decrypt(user.garmin_password);

    const client = new GarminConnect({ username: user.garmin_username, password: garmin_password });
    try {
        await client.login(user.garmin_username, garmin_password);
        console.log("Logged in!");

        const testPayloads = [
            // Test 1: Just strings
            { category: "SQUAT", exerciseName: "BACK_SQUATS" },
            // Test 2: category as object with categoryKey, exerciseName as string
            { category: { categoryKey: "SQUAT" }, exerciseName: "BACK_SQUATS" },
            // Test 3: category as string, exerciseName as object
            { category: "SQUAT", exerciseName: { exerciseNameKey: "BACK_SQUATS" } },
            // Test 4: both as objects
            { category: { categoryKey: "SQUAT" }, exerciseName: { exerciseNameKey: "BACK_SQUATS" } },
            // Test 5: categoryId and exerciseNameId
            { category: { categoryId: 1, categoryKey: "SQUAT" }, exerciseName: "BACK_SQUATS" },
            // Test 6: Maybe exerciseName is just the string, and category expects categoryKey?
            { category: "SQUAT" },
            // Test 7: category as object with categoryId and exerciseName as string
            { category: { categoryId: 3, categoryKey: "SQUAT" }, exerciseName: "BACK_SQUATS" },
            // Test 8: exerciseCategory and exerciseName
            { exerciseCategory: { categoryKey: "SQUAT" }, exerciseName: "BACK_SQUATS" }
        ];

        for (let i = 0; i < testPayloads.length; i++) {
            console.log(`\n--- Test ${i + 1} ---`);
            const payload = testPayloads[i];
            console.log("Payload:", payload);
            
            const wkt = {
                workoutName: `Test Strength ${i+1}`,
                description: "Test",
                sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
                workoutSegments: [{
                    segmentOrder: 1,
                    sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
                    workoutSteps: [{
                        type: "ExecutableStepDTO",
                        stepOrder: 1,
                        stepType: { stepTypeId: 3, stepTypeKey: "interval" },
                        endCondition: { conditionTypeId: 3, conditionTypeKey: "reps" },
                        endConditionValue: 8,
                        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
                        ...payload
                    }]
                }]
            };

            try {
                const res = await client.post('https://connectapi.garmin.com/workout-service/workout', wkt);
                console.log(`Test ${i + 1} SUCCESS! Workout ID: ${res?.workoutId || res?.data?.workoutId}`);
                // Delete it if successful
                if (res?.workoutId || res?.data?.workoutId) {
                    await client.delete(`https://connectapi.garmin.com/workout-service/workout/${res?.workoutId || res?.data?.workoutId}`);
                }
                break; // Stop on first success
            } catch (err) {
                console.error(`Test ${i + 1} Failed: ${err.message}`);
                if (err.response && err.response.data) {
                    console.error("Data:", err.response.data);
                }
            }
        }
    } catch (e) {
        console.error("Login failed", e.message);
    }
});
