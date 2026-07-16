const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nana_multi.db');

db.all(`SELECT user_id, start_date, substr(start_date, 1, 10) as date, tss, sport_type, elevation_m, moving_time_min FROM activities ORDER BY start_date ASC`, [], (err, rows) => {
    if (err) throw err;
    
    const userStats = {};
    rows.forEach(r => {
        if (!userStats[r.user_id]) {
            userStats[r.user_id] = { 
                ctlMap: {}, earliest: r.date, 
                weightTrainingCount: 0, totalElevation: 0, 
                uniqueSports: new Set(), explosiveSessions: 0 
            };
        }
        const stats = userStats[r.user_id];
        if (!stats.earliest) stats.earliest = r.date;
        
        stats.ctlMap[r.date] = (stats.ctlMap[r.date] || 0) + (r.tss || 0);
        
        if (r.sport_type === 'WeightTraining') stats.weightTrainingCount++;
        stats.totalElevation += (r.elevation_m || 0);
        if (r.sport_type) stats.uniqueSports.add(r.sport_type);
        if (r.moving_time_min && (r.tss / r.moving_time_min) > 1.2) stats.explosiveSessions++;
    });

    let globalMax = { ctl: 1, strength: 1, versatility: 1, explosiveness: 1 };
    let rawScores = {};

    Object.keys(userStats).forEach(uid => {
        const stats = userStats[uid];
        
        let ctl = 0;
        if (stats.earliest) {
            let currentDate = new Date(stats.earliest);
            const today = new Date();
            currentDate.setUTCHours(0,0,0,0);
            today.setUTCHours(0,0,0,0);
            while (currentDate <= today) {
                const dateStr = currentDate.toISOString().split('T')[0];
                const dailyTss = stats.ctlMap[dateStr] || 0;
                ctl = ctl + (dailyTss - ctl) * (1 - Math.exp(-1/42));
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        }
        
        let strengthScore = (stats.weightTrainingCount * 5) + (stats.totalElevation / 1000);
        let versatilityScore = stats.uniqueSports.size;
        let explosivenessScore = stats.explosiveSessions;

        if (ctl > globalMax.ctl) globalMax.ctl = ctl;
        if (strengthScore > globalMax.strength) globalMax.strength = strengthScore;
        if (versatilityScore > globalMax.versatility) globalMax.versatility = versatilityScore;
        if (explosivenessScore > globalMax.explosiveness) globalMax.explosiveness = explosivenessScore;
        
        rawScores[uid] = {
            ctl: ctl,
            strength: strengthScore,
            versatility: versatilityScore,
            explosiveness: explosivenessScore
        };
    });

    db.all(`SELECT id, username FROM users`, [], (err, users) => {
        const userMap = {};
        if (users) {
            users.forEach(u => userMap[u.id] = u.username);
        }

        const tableData = [];
        
        Object.keys(rawScores).forEach(uid => {
            const raw = rawScores[uid];
            tableData.push({
                "User": userMap[uid] || `User ${uid}`,
                "Endurance (CTL)": Math.round(raw.ctl),
                "Endurance %": Math.min(100, Math.round((raw.ctl / globalMax.ctl) * 100)) + '%',
                "Strength (Raw)": Math.round(raw.strength),
                "Strength %": Math.min(100, Math.round((raw.strength / globalMax.strength) * 100)) + '%',
                "Versatility (# Sports)": raw.versatility,
                "Versatility %": Math.min(100, Math.round((raw.versatility / globalMax.versatility) * 100)) + '%',
                "Explosiveness (Hits)": raw.explosiveness,
                "Explosiveness %": Math.min(100, Math.round((raw.explosiveness / globalMax.explosiveness) * 100)) + '%'
            });
        });

        console.log("=== GLOBAL MAXIMUMS ===");
        console.table({
            "Endurance (CTL)": Math.round(globalMax.ctl),
            "Strength": Math.round(globalMax.strength),
            "Versatility": Math.round(globalMax.versatility),
            "Explosiveness": Math.round(globalMax.explosiveness)
        });
        
        console.log("\n=== ATHLETE SCORES & RADAR PERCENTAGES ===");
        console.table(tableData);
    });
});
