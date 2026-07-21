const sseClients = new Map();

function sendSSEEvent(userId, eventName, data) {
  const client = sseClients.get(userId);
  if (client) {
    client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

module.exports = {
  sseClients,
  sendSSEEvent
};
