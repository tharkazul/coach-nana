const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/micro-plan/2',
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer 1' // Assuming token is 1 for user 1?
  }
};

const req = http.request(options, res => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', d => process.stdout.write(d));
});

req.on('error', e => console.error(`problem with request: ${e.message}`));

req.write(JSON.stringify({
  date: '2026-06-23',
  sport: 'Bike',
  description: 'Pedal Power Introduction',
  target_tss: 65,
  details: '',
  steps_json: '[]'
}));
req.end();
