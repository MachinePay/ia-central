// Service worker minimo: so para mostrar notificacoes (no Android o navegador exige um).
// Nao guarda nada em cache: o painel sempre vem atualizado.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const aberta = lista.find(c => 'focus' in c)
    return aberta ? aberta.focus() : self.clients.openWindow('/')
  }))
})
