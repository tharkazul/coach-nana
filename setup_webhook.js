require('dotenv').config();

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const VERIFY_TOKEN = "STRAVA"; // Your code in integrations.js expects "STRAVA"

async function setupWebhook(domain) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env");
        return;
    }

    if (!domain) {
        console.error("Please provide your production domain. Usage: node setup_webhook.js https://yourdomain.com");
        return;
    }

    // 1. Get existing subscriptions
    console.log("Checking existing subscriptions...");
    const res = await fetch(`https://www.strava.com/api/v3/push_subscriptions?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`);
    const subs = await res.json();
    
    if (subs && subs.length > 0) {
        console.log(`Found ${subs.length} existing subscriptions. Deleting them...`);
        for (const sub of subs) {
            await fetch(`https://www.strava.com/api/v3/push_subscriptions/${sub.id}?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`, {
                method: 'DELETE'
            });
            console.log(`Deleted subscription ${sub.id}`);
        }
    }

    // 2. Create new subscription
    const callbackUrl = `${domain.replace(/\/$/, '')}/webhook/strava`;
    console.log(`Creating new subscription for ${callbackUrl}...`);
    
    const createRes = await fetch(`https://www.strava.com/api/v3/push_subscriptions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            callback_url: callbackUrl,
            verify_token: VERIFY_TOKEN
        })
    });

    const createData = await createRes.json();
    if (createData.id) {
        console.log("✅ Successfully created webhook subscription! ID:", createData.id);
    } else {
        console.error("❌ Failed to create subscription:", createData);
    }
}

const domain = process.argv[2];
setupWebhook(domain);
