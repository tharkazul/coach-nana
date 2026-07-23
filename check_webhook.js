require('dotenv').config();

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

async function checkWebhook() {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env");
        return;
    }

    console.log("Fetching active Strava webhook subscriptions...");
    try {
        const res = await fetch(`https://www.strava.com/api/v3/push_subscriptions?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`);
        const subs = await res.json();
        
        if (subs && subs.length > 0) {
            console.log(`✅ Found ${subs.length} active subscription(s):`);
            console.log(JSON.stringify(subs, null, 2));
        } else {
            console.log("❌ No active subscriptions found.");
        }
    } catch (e) {
        console.error("Error fetching webhooks:", e);
    }
}

checkWebhook();
