// Service worker minimal : necessaire pour que Chrome/Android propose une
// vraie installation ("Installer l'application") plutot qu'un simple
// raccourci badge Chrome sur l'ecran d'accueil. Ne met rien en cache : toutes
// les requetes passent normalement au reseau, l'app reste toujours a jour.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
