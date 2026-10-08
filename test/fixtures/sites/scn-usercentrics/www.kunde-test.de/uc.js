/*
 * Simulated Usercentrics banner in an *open shadow root*.
 *   data-version="2": <div id="usercentrics-root"> with data-testid="uc-*-button" controls and a
 *                     window.UC_UI API (as the real v2 loader; autoconsent uses it),
 *   data-version="3": <aside id="usercentrics-cmp-ui"> with data-action-type controls and
 *                     custom labels (no UC_UI – only the markup identifies the controls).
 * data-delay: ms after the load event until the banner appears (slow CMP).
 */
(function () {
  var me = document.currentScript;
  var version = me.getAttribute('data-version') || '2';
  var delay = Number(me.getAttribute('data-delay') || 0);
  function loadTrackers() {
    var s = document.createElement('script');
    s.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-UC';
    document.head.appendChild(s);
  }
  var m = document.cookie.match(/(?:^|; )uc_consent=([^;]+)/);
  if (m) {
    if (m[1] === 'all') loadTrackers();
    return;
  }
  var host;
  var accepted = false;
  function close() { if (host) host.remove(); }
  function decide(all) {
    accepted = all;
    document.cookie = 'uc_consent=' + (all ? 'all' : 'none') + '; path=/';
    close();
    if (all) loadTrackers();
  }
  var css = '<style>.banner{position:fixed;left:0;right:0;bottom:0;background:#fff;padding:20px;' +
    'box-shadow:0 -2px 8px rgba(0,0,0,.3);font:14px sans-serif;z-index:99999}' +
    'button{padding:12px 20px;margin-right:8px}</style>';
  var text = '<h2>Privatsphäre-Einstellungen</h2><p>Diese Seite nutzt zustimmungspflichtige Cookies ' +
    'und Technologien von Drittanbietern. Ihre Einwilligung können Sie jederzeit widerrufen ' +
    '(Datenschutzerklärung).</p>';
  function show() {
    if (version === '3') {
      host = document.createElement('aside');
      host.id = 'usercentrics-cmp-ui';
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML = css + '<div class="banner" id="uc-main-dialog" role="dialog">' + text +
        '<button id="more" class="more uc-more-button" data-action-type="more">Optionen</button>' +
        '<button id="deny" class="deny uc-deny-button" data-action-type="deny">Nein, danke</button>' +
        '<button id="accept" class="accept uc-accept-button" data-action-type="accept">Passt für mich</button></div>';
      root.getElementById('deny').addEventListener('click', function () { decide(false); });
      root.getElementById('accept').addEventListener('click', function () { decide(true); });
    } else {
      host = document.createElement('div');
      host.id = 'usercentrics-root';
      var r = host.attachShadow({ mode: 'open' });
      r.innerHTML = css + '<div class="banner" data-testid="uc-container" role="dialog">' + text +
        '<button data-testid="uc-more-button">Mehr</button>' +
        '<button data-testid="uc-deny-all-button">Ablehnen</button>' +
        '<button data-testid="uc-accept-all-button">Alles akzeptieren</button></div>';
      r.querySelector('[data-testid="uc-deny-all-button"]').addEventListener('click', function () { decide(false); });
      r.querySelector('[data-testid="uc-accept-all-button"]').addEventListener('click', function () { decide(true); });
      window.UC_UI = {
        acceptAllConsents: function () { decide(true); return Promise.resolve(); },
        denyAllConsents: function () { decide(false); return Promise.resolve(); },
        closeCMP: function () { close(); return Promise.resolve(); },
        areAllConsentsAccepted: function () { return accepted; },
        isInitialized: function () { return true; },
      };
    }
    document.body.appendChild(host);
  }
  window.addEventListener('load', function () { setTimeout(show, delay); });
})();
