// Broken CMP: banner with buttons that do nothing.
(function () {
  function show() {
    var d = document.createElement('div');
    d.id = 'kt-cookie-banner';
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:2px solid #333;padding:20px;z-index:9999;font:16px sans-serif';
    d.innerHTML = '<p>Wir verwenden Cookies. <a href="/datenschutz.html">Datenschutzerklärung</a> · <a href="/impressum.html">Impressum</a></p>' +
      '<button id="kt-reject">Alle ablehnen</button> <button id="kt-accept">Alle akzeptieren</button>';
    document.body.appendChild(d);
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
