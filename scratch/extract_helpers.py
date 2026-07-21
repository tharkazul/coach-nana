import re

def extract_functions(filepath, output_dir):
    with open(filepath, 'r') as f:
        content = f.read()

    function_names = [
        "matchGarminExercise",
        "getAMSDateString",
        "getAMSWeekday",
        "getUserGamificationContext",
        "getUserLeaderboardString",
        "getWeatherContext",
        "getUserMacroPhase",
        "generatePublicProfile",
        "calculateGlobalMaxStats",
        "generateAllPublicProfiles",
        "processTokenRefresh",
        "getStravaTokenForUser",
        "getSparkLevelInfo",
        "calculateSparkScore",
        "mapStravaSportToSpark",
        "formatStepsForStrava",
        "tagStravaActivity",
        "getStravaActivity",
        "syncAllStravaUsersOnStartup",
        "triggerBackgroundSummary",
        "updateUserSparkAndCheckLevel",
        "triggerLevelUpCoachPrompt",
        "generateQuestForUser",
        "evaluateQuestsAgainstActivity"
    ]
    
    extracted_code = []
    
    for fn_name in function_names:
        # Regex to find the start of the function:
        pattern = re.compile(rf'^(async\s+)?function\s+{fn_name}\s*\(', re.MULTILINE)
        match = pattern.search(content)
        if not match:
            pattern2 = re.compile(rf'^const\s+{fn_name}\s*=\s*(async\s+)?function\s*\(', re.MULTILINE)
            match = pattern2.search(content)
            if not match:
                pattern3 = re.compile(rf'^const\s+{fn_name}\s*=\s*(async\s*)?\(', re.MULTILINE)
                match = pattern3.search(content)
                if not match:
                    print(f"Could not find function {fn_name}")
                    continue
        
        start_idx = match.start()
        
        # Find the next ^}
        end_pattern = re.compile(r'^}', re.MULTILINE)
        end_match = end_pattern.search(content, start_idx)
        if end_match:
            end_idx = end_match.end()
        else:
            end_idx = len(content)
            
        extracted = content[start_idx:end_idx].strip()
        extracted_code.append(extracted)

    # Generate utils.js
    out_content = "const db = require('./db');\n"
    out_content += "const fs = require('fs');\n"
    out_content += "const path = require('path');\n"
    out_content += "const crypto = require('crypto');\n"
    out_content += "const fuzzysort = require('fuzzysort');\n"
    out_content += "const { sendSSEEvent } = require('./sse');\n"
    out_content += "const { generateWithFallback } = require('./ai');\n\n"
    
    out_content += """
let garminExercises = [];
try {
  garminExercises = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../garmin_exercises.json"), "utf8"),
  );
  console.log(
    `Loaded ${garminExercises.length} Garmin exercises for fuzzy matching.`,
  );
} catch (e) {
  console.error("Could not load garmin_exercises.json:", e);
}
"""
    
    for code in extracted_code:
        out_content += code + "\n\n"
        
    out_content += "module.exports = {\n"
    for fn in function_names:
        out_content += f"  {fn},\n"
    out_content += "};\n"
    
    with open(f"{output_dir}/utils.js", "w") as f:
        f.write(out_content)
        
    print(f"Generated utils.js with {len(extracted_code)} functions.")

if __name__ == "__main__":
    extract_functions('../server.old.js', '../services/')
