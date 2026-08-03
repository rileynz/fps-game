'use strict';

const CACHE_NAME='arena-shell-v4';
const APP_SHELL=[
  '/manifest.json',
  '/platform-commerce.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(APP_SHELL))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys
        .filter(key=>key.startsWith('arena-shell-v')&&key!==CACHE_NAME)
        .map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

async function networkFirst(request){
  const cache=await caches.open(CACHE_NAME);
  try{
    const response=await fetch(request);
    if(response&&response.ok)cache.put(request,response.clone());
    return response;
  }catch(error){
    const cached=await cache.match(request);
    if(cached)return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request){
  const cache=await caches.open(CACHE_NAME);
  const cached=await cache.match(request);
  const refresh=fetch(request).then(response=>{
    if(response&&response.ok)cache.put(request,response.clone());
    return response;
  });
  return cached||refresh;
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  // Never cache live state, account, analytics, payment or admin requests.
  if(
    url.pathname.startsWith('/socket.io/')
    ||url.pathname.startsWith('/api/')
    ||url.pathname.startsWith('/admin')
  )return;

  if(request.mode==='navigate'){
    event.respondWith(networkFirst(request));
    return;
  }
  if(
    url.pathname.startsWith('/icons/')
    ||/\.(?:js|css|png|jpg|jpeg|webp|svg|ico|woff2?|json)$/i.test(url.pathname)
  ){
    event.respondWith(staleWhileRevalidate(request));
  }
});
