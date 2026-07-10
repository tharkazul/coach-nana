const CACHE_NAME = 'coach-nana-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/script.js',
    '/icon4.png',
    '/avatars/default.jpg',
    '/avatars/happy.jpg',
    '/avatars/proud.jpg',
    '/avatars/thinking.jpg',
    '/avatars/disappointed.jpg'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Opened cache');
                return cache.addAll(STATIC_ASSETS);
            })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch event - network first for API, cache first for static
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // For API calls, always go to network
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch((err) => {
                console.error('API fetch failed in offline mode:', err);
                return new Response(JSON.stringify({ error: 'You are offline. Reconnect to sync with Coach Nana.' }), {
                    headers: { 'Content-Type': 'application/json' },
                    status: 503
                });
            })
        );
        return;
    }

    // For static assets, try cache first, then network
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                if (response) {
                    return response; // Return from cache
                }
                
                // Clone the request because it's a one-time use stream
                const fetchRequest = event.request.clone();

                return fetch(fetchRequest).then((networkResponse) => {
                    // Check if we received a valid response
                    if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                        return networkResponse;
                    }

                    // Clone the response because we need to put one copy in cache and return the other
                    const responseToCache = networkResponse.clone();
                    
                    // Only cache GET requests
                    if (event.request.method === 'GET') {
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }

                    return networkResponse;
                }).catch(() => {
                    // If both cache and network fail (offline and not cached), fallback to index.html for navigation
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                });
            })
    );
});
