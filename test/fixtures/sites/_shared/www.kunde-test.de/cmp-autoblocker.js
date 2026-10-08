// Simulated "autoblocker" CMP (like Usercentrics/CCM19 auto-blocking): it runs *after* the
// iframe has already been parsed and rewrites src -> data-src. Too late: the browser has
// already started the iframe navigation and opened a socket to the third party.
(function () {
  window.__cmpLoadedAt = performance.now();
  var blocked = /youtube\.com|youtube-nocookie\.com|google|facebook/;
  document.querySelectorAll('iframe[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (src && blocked.test(src)) {
      el.setAttribute('data-src', src);
      el.removeAttribute('src');
      el.src = 'about:blank';
    }
  });
  var banner = document.createElement('div');
  banner.id = 'cmp-banner';
  banner.innerHTML =
    '<p>Wir verwenden Cookies.</p>' +
    '<button id="cmp-accept">Alle akzeptieren</button>' +
    '<button id="cmp-reject">Alle ablehnen</button>';
  document.body.appendChild(banner);
  function unblock() {
    document.querySelectorAll('iframe[data-src]').forEach(function (el) {
      el.src = el.getAttribute('data-src');
    });
    banner.remove();
  }
  document.getElementById('cmp-accept').addEventListener('click', unblock);
  document.getElementById('cmp-reject').addEventListener('click', function () {
    banner.remove();
  });
})();
