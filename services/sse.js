const sseClients = new Map();

function sendSSEEvent(userId, eventName, data) {
  const clients = sseClients.get(userId);
  if (clients) {
    for (const res of clients) {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}

module.exports = {
  sseClients,
  sendSSEEvent
};
