// Correctly configured CMP: nothing third-party before consent; the video uses data-src and
// GTM is only loaded after "accept".
(function () {
  var KEY = 'kt_consent';
  function unblock() {
    var s = document.createElement('script');
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-TEST';
    s.async = true;
    document.head.appendChild(s);
    document.querySelectorAll('iframe[data-src]').forEach(function (el) {
      el.src = el.getAttribute('data-src');
    });
  }
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (stored === 'all') { unblock(); return; }
  if (stored) return;
  function show() {
    var d = document.createElement('div');
    d.id = 'kt-cookie-banner';
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:2px solid #333;padding:20px;z-index:9999;font:16px sans-serif';
    d.innerHTML = '<p>Wir verwenden Cookies. Mit Ihrer Einwilligung laden wir YouTube-Videos und Google Analytics. ' +
      '<a href="/datenschutz.html">Datenschutzerklärung</a> · <a href="/impressum.html">Impressum</a></p>' +
      '<button id="kt-reject">Alle ablehnen</button> <button id="kt-accept">Alle akzeptieren</button>';
    document.body.appendChild(d);
    d.querySelector('#kt-reject').onclick = function () {
      try { localStorage.setItem(KEY, 'necessary'); } catch (e) {}
      d.remove();
    };
    d.querySelector('#kt-accept').onclick = function () {
      try { localStorage.setItem(KEY, 'all'); } catch (e) {}
      d.remove();
      unblock();
    };
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
