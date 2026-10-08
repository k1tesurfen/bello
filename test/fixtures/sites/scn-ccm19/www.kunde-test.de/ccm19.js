/*
 * Simulated CCM19 widget (markup as on real CCM19 installations): #ccm-widget role=dialog with
 * category switches, button.ccm--save-settings[data-full-consent=true] ("accept all"),
 * button.ccm--decline-cookies ("reject all") and a[data-ccm-modal=ccm-details] ("Einstellungen").
 * data-labels="eigene": custom button labels – only the CCM19 markup identifies the controls.
 */
(function () {
  var me = document.currentScript;
  var custom = me.getAttribute('data-labels') === 'eigene';
  function loadTrackers() {
    var s = document.createElement('script');
    s.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-CCM';
    document.head.appendChild(s);
  }
  var m = document.cookie.match(/(?:^|; )ccm_consent=([^;]+)/);
  if (m) {
    if (m[1] === 'all') loadTrackers();
    return;
  }
  function show() {
    var w = document.createElement('div');
    w.id = 'ccm-widget';
    w.className = 'ccm-modal ccm-widget ccm--alignment--bottom ccm-show';
    w.setAttribute('role', 'dialog');
    w.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#eee;padding:20px;font:14px sans-serif;z-index:9999';
    w.innerHTML =
      '<div class="ccm-modal-inner"><div class="ccm-modal--body">' +
      '<h2 id="ccm-widget--title">Wir nutzen Cookies und andere Technologien.</h2>' +
      '<p>Diese Seite nutzt einwilligungsbedürftige Cookies und Technologien von Drittunternehmen. ' +
      'Sie können Ihre Einwilligung jederzeit widerrufen (Datenschutzhinweis).</p>' +
      '<div class="ccm-widget--switches">' +
      '<label><input type="checkbox" checked disabled> Technisch notwendig</label> ' +
      '<label><input type="checkbox" name="ccm-statistik"> Analyse / Statistiken</label> ' +
      '<button type="button" class="ccm-info-button ccm--ctrl-init" data-ccm-modal="ccm-details">?</button>' +
      '</div>' +
      '<div class="ccm-widget--buttons">' +
      '<button type="button" class="button ccm--save-settings ccm--button-primary ccm--ctrl-init" data-full-consent="true">' +
      (custom ? 'Okay, passt' : 'ALLES AKZEPTIEREN') + '</button> ' +
      '<button type="button" class="button ccm--decline-cookies ccm--ctrl-init">' +
      (custom ? 'Nein, danke' : 'ALLES ABLEHNEN') + '</button>' +
      '</div>' +
      '<a href="#" class="ccm-must-show ccm--ctrl-init" data-ccm-modal="ccm-details">Einstellungen</a>' +
      '</div></div>';
    document.body.appendChild(w);
    function decide(all) {
      document.cookie = 'ccm_consent=' + (all ? 'all' : 'none') + '; path=/';
      w.classList.remove('ccm-show');
      w.style.display = 'none';
      if (all) loadTrackers();
    }
    w.querySelector('.ccm--save-settings').addEventListener('click', function () { decide(true); });
    w.querySelector('.ccm--decline-cookies').addEventListener('click', function () { decide(false); });
  }
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
