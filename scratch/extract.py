import re

def extract_routes(filepath, output_dir, route_groups):
    with open(filepath, 'r') as f:
        content = f.read()

    # Find all starts
    pattern = re.compile(r'^app\.(get|post|put|delete|patch)\s*\(\s*[\'"](/[^\'"]+)[\'"]', re.MULTILINE)
    matches = list(pattern.finditer(content))
    
    routes = []
    
    for i, match in enumerate(matches):
        method = match.group(1)
        path = match.group(2)
        start_idx = match.start()
        
        # Find the next ^});
        end_pattern = re.compile(r'^}\);', re.MULTILINE)
        end_match = end_pattern.search(content, start_idx)
        if end_match:
            end_idx = end_match.end()
        else:
            end_idx = len(content)
            
        route_code = content[start_idx:end_idx].strip()
        route_code = re.sub(r'^app\.', 'router.', route_code)
        
        routes.append({'path': path, 'code': route_code})

    # Group the routes
    for group_name, prefix_list in route_groups.items():
        group_routes = []
        for r in routes:
            if any(r['path'].startswith(prefix) for prefix in prefix_list):
                group_routes.append(r)
                
        if not group_routes:
            continue
            
        # Generate the route file content
        out_content = "const express = require('express');\nconst router = express.Router();\n"
        out_content += "const db = require('../services/db');\n"
        out_content += "const fs = require('fs');\n"
        out_content += "const path = require('path');\n"
        out_content += "const crypto = require('crypto');\n"
        out_content += "const multer = require('multer');\n"
        
        if group_name == 'physique' or group_name == 'chat':
            out_content += """
const physiqueStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../secure_uploads/physique");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `physique_${req.user.id}_${crypto.randomUUID()}${ext}`);
  },
});
const uploadPhysique = multer({ storage: physiqueStorage });

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../public/uploads/profiles");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
  },
});
const uploadProfile = multer({ storage: profileStorage });
"""

        out_content += "const { authenticateToken } = require('../services/auth');\n"
        out_content += "const { sseClients, sendSSEEvent } = require('../services/sse');\n"
        out_content += "const { generateWithFallback } = require('../services/ai');\n"
        out_content += "const { encrypt, decrypt } = require('../services/crypto');\n"
        out_content += "const {\n"
        out_content += "  matchGarminExercise,\n"
        out_content += "  getAMSDateString,\n"
        out_content += "  getAMSWeekday,\n"
        out_content += "  getUserGamificationContext,\n"
        out_content += "  getUserLeaderboardString,\n"
        out_content += "  getWeatherContext,\n"
        out_content += "  getUserMacroPhase,\n"
        out_content += "  generatePublicProfile,\n"
        out_content += "  calculateGlobalMaxStats,\n"
        out_content += "  generateAllPublicProfiles,\n"
        out_content += "  processTokenRefresh,\n"
        out_content += "  getStravaTokenForUser,\n"
        out_content += "  getSparkLevelInfo,\n"
        out_content += "  calculateSparkScore,\n"
        out_content += "  mapStravaSportToSpark,\n"
        out_content += "  formatStepsForStrava,\n"
        out_content += "  tagStravaActivity,\n"
        out_content += "  getStravaActivity,\n"
        out_content += "  syncAllStravaUsersOnStartup,\n"
        out_content += "  triggerBackgroundSummary,\n"
        out_content += "  updateUserSparkAndCheckLevel,\n"
        out_content += "  triggerLevelUpCoachPrompt,\n"
        out_content += "  generateQuestForUser,\n"
        out_content += "  evaluateQuestsAgainstActivity\n"
        out_content += "} = require('../services/utils');\n"
        out_content += "\n"
        
        for r in group_routes:
            out_content += r['code'] + "\n\n"
            
        out_content += "module.exports = router;\n"
        
        with open(f"{output_dir}/{group_name}.js", "w") as f:
            f.write(out_content)
        
        print(f"Generated {group_name}.js with {len(group_routes)} routes.")

if __name__ == "__main__":
    groups = {
        'chat': ['/api/chat', '/api/events'],
        'social': ['/api/social', '/api/connections', '/api/kudos', '/api/my-profile', '/api/search/users'],
        'gamification': ['/api/quests', '/api/titles', '/api/bonus-points', '/api/milestones', '/api/gamification'],
        'integrations': ['/webhook/strava', '/api/sync-strava', '/api/user/settings/strava', '/api/user/settings/garmin', '/api/user/disconnect', '/api/sync-garmin'],
        'physique': ['/api/physique', '/api/weight', '/api/user/cycle/log', '/api/niggles', '/api/images/physique', '/api/images/chat'],
        'activities': ['/api/micro-plan', '/api/activity', '/api/history', '/api/dashboard-data', '/api/generate-plan', '/api/user/metrics', '/api/user/activities', '/api/user/strava-opt-out']
    }
    extract_routes('../server.old.js', '../routes/', groups)
