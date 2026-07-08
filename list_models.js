const fs = require('fs');
require('dotenv').config();

async function run() {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    console.log(data.models.map(m => m.name).join('\n'));
  } catch (e) {
    console.error('Error:', e.message);
  }
}
run();
