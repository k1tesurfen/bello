/*
 * Simulated Sourcepoint top-frame stub: the consent message lives in a *cross-origin* iframe
 * (cdn.jsdelivr.net/index.html?message_id=…) inside div#sp_message_container_<id>; "Einstellungen"
 * replaces it with the privacy manager iframe (/privacy-manager/index.html?message_id=…).
 * The iframes report the decision via postMessage. Variant via <script data-variant>:
 *   standard – accept / reject / settings on the first layer
 *   pm       – accept / settings; "Alle ablehnen" only in the privacy manager
 *   pur      – accept / "Pur-Abo abschließen" / settings; the privacy manager has a purpose that
 *              cannot be rejected and "Ausgewähltem zustimmen" stays disabled (consent or pay)
 */
(function () {
  var variant = document.currentScript.getAttribute('data-variant') || 'standard';
  var FRAME = 'https://cdn.jsdelivr.net';
  function loadTrackers() {
    var s = document.createElement('script');
    s.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-SP';
    document.head.appendChild(s);
  }
  var m = document.cookie.match(/(?:^|; )sp_consent=([^;]+)/);
  if (m) {
    if (m[1] === 'all') loadTrackers();
    return;
  }
  function container(id, src, height) {
    var c = document.createElement('div');
    c.id = 'sp_message_container_' + id;
    c.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center';
    var f = document.createElement('iframe');
    f.id = 'sp_message_iframe_' + id;
    f.title = 'SP Consent Message';
    f.src = src;
    f.style.cssText = 'width:760px;height:' + height + 'px;border:0;background:#fff';
    c.appendChild(f);
    document.documentElement.classList.add('sp-message-open');
    document.body.appendChild(c);
    return c;
  }
  function closeAll() {
    document.querySelectorAll('div[id^="sp_message_container_"]').forEach(function (c) { c.remove(); });
    document.documentElement.classList.remove('sp-message-open');
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== FRAME || !e.data || e.data.sp !== 'choice') return;
    if (e.data.choice === 'accept') {
      document.cookie = 'sp_consent=all; path=/';
      closeAll();
      loadTrackers();
    } else if (e.data.choice === 'reject') {
      document.cookie = 'sp_consent=none; path=/';
      closeAll();
    } else if (e.data.choice === 'pm') {
      closeAll();
      container('2', FRAME + '/privacy-manager/index.html?message_id=2&variant=' + variant, 640);
    }
  });
  function show() {
    container('1', FRAME + '/index.html?message_id=1&consentUUID=null&variant=' + variant, 420);
  }
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
