const fuzzysort = require('fuzzysort');
const fs = require('fs');
let garminExercises = JSON.parse(fs.readFileSync('./garmin_exercises.json', 'utf8'));

function matchGarminExercise(name) {
    const results = fuzzysort.go(name, garminExercises, {key: 'exercise_name', limit: 1});
    if (results && results.length > 0) {
        if (results[0].score > -10000) {
            return { obj: results[0].obj, score: results[0].score };
        }
    }
    return null;
}

console.log("Back Squat:", matchGarminExercise("Back Squat"));
console.log("Dumbbell Crossover Lunge:", matchGarminExercise("Dumbbell Crossover Lunge"));
console.log("Bench Press:", matchGarminExercise("Bench Press"));
console.log("DB Curl:", matchGarminExercise("DB Curl"));
