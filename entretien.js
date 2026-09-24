/* =====================================================================
   Maintenance DTT — suivi d'exécution (Direction des travaux du territoire)
   ---------------------------------------------------------------------
   Reprend le référentiel d'interventions, n'affiche que celles que
   l'arbitrage a orientées vers la maintenance DTT, et conserve leur
   avancement dans la table « entretien_suivi ».

   Deux tables, deux portées : la DTT écrit son compte rendu, elle ne
   touche pas aux arbitrages, qu'elle lit seulement. Les montants saisis
   ici n'atteignent jamais « operations » — le plan reste hors de portée.

   La page réutilise la session de source.js. Elle y ajoute une entrée par
   mot de passe : le service de courriel de Supabase est plafonné à deux
   envois par heure tant qu'aucun SMTP n'est branché, ce qui rend le lien
   magique impraticable pour ouvrir l'accès à une autre direction.
   ===================================================================== */
(function () {
  'use strict';

  var STATUTS = [
    { v: 'a_faire',    l: 'À faire',    c: 's1' },
    { v: 'programme',  l: 'Programmée', c: 's2' },
    { v: 'termine',    l: 'Terminée',   c: 's3' },
    { v: 'sans_suite', l: 'Sans suite', c: 's4' }
  ];
  var LIB = { a_faire:'À faire', programme:'Programmée', termine:'Terminée', sans_suite:'Sans suite' };

  var DATA = [];                      // interventions confiées à la maintenance DTT
  var S = Object.create(null);        // id -> suivi
  var filtres = { statut: '', rang: '', sect: '', q: '' };
  var minuteurs = Object.create(null);

  var $  = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  var euro = function (n) { return (Math.round(n) || 0).toLocaleString('fr-FR') + ' €'; };

  function etat(msg, duree) {
    var e = $('#etat'); e.textContent = msg; e.classList.add('on');
    clearTimeout(etat._t);
    etat._t = setTimeout(function () { e.classList.remove('on'); }, duree || 3200);
  }

  /* ---------------------------------------------------------- Supabase */
  function sbUrl(p) { return CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1' + p; }
  function entetes(json) {
    var s = Source.session();
    var h = { apikey: CONFIG.SUPABASE_CLE_PUBLIQUE,
              Authorization: 'Bearer ' + (s && s.token ? s.token : CONFIG.SUPABASE_CLE_PUBLIQUE) };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  async function sb(chemin, opts) {
    opts = opts || {};
    var r = await fetch(sbUrl(chemin), {
      method: opts.method || 'GET',
      headers: Object.assign(entetes(!!opts.corps), opts.entetes || {}),
      body: opts.corps ? JSON.stringify(opts.corps) : undefined
    });
    if (!r.ok) {
      var t = await r.text(), d = {};
      try { d = JSON.parse(t); } catch (e) {}
      if (r.status === 401 || r.status === 403) {
        if (d.code === '42501' || /row-level security/i.test(t)) {
          throw new Error('La base refuse l’écriture : votre compte n’a pas le rôle « dtt ». ' +
            'Demandez à la Direction de l’Éducation d’exécuter supabase/comptes-dtt.sql.');
        }
        throw new Error('Accès refusé par la base : ' + (d.message || t.slice(0, 120)));
      }
      if (/relation .*entretien_suivi.* does not exist/i.test(t)) {
        throw new Error('La table « entretien_suivi » n’existe pas encore. ' +
          'Exécutez supabase/entretien-suivi.sql dans l’éditeur SQL de Supabase.');
      }
      throw new Error('Base de données : ' + r.status + ' ' + t.slice(0, 140));
    }
    // « return=minimal » renvoie un corps vide : le lire comme du JSON
    // échouerait alors que l'écriture a bien eu lieu.
    if (r.status === 204) return null;
    var corps = await r.text();
    if (!corps) return null;
    try { return JSON.parse(corps); } catch (e) { return null; }
  }

  function peutEcrire() {
    var s = Source.session();
    // peutEcrire() de source.js ne connaît que « redacteur » et « admin » :
    // le rôle « dtt » s'y verrait refusé. Le contrôle est donc refait ici.
    return !!(s && (s.role === 'dtt' || s.role === 'admin'));
  }

  /* ------------------------------------------------------- chargements */
  async function charger() {
    var r = await fetch('donnees/arbitrage-interventions.json?v=4');
    if (!r.ok) throw new Error('Référentiel des interventions introuvable.');
    var toutes = await r.json();
    var idx = {};
    toutes.forEach(function (x) { idx[x.id] = x; });

    // les interventions que l'arbitrage a confiées à la maintenance DTT
    var arb = await sb('/arbitrages?select=id,destination&destination=eq.entretien');
    DATA = (arb || []).map(function (a) { return idx[a.id]; }).filter(Boolean);

    // tri : priorité d'abord, puis école — c'est l'ordre d'un plan de charge
    var rang = { P1: 0, P2: 1, P3: 2, P4: 3 };
    DATA.sort(function (a, b) {
      var d = (rang[a.rang] == null ? 9 : rang[a.rang]) - (rang[b.rang] == null ? 9 : rang[b.rang]);
      return d || String(a.ecolePPI).localeCompare(String(b.ecolePPI), 'fr');
    });

    var secteurs = {};
    DATA.forEach(function (x) { if (x.secteur) secteurs[x.secteur] = 1; });
    Object.keys(secteurs).sort().forEach(function (s) {
      var o = document.createElement('option'); o.value = s; o.textContent = s; $('#fsect').appendChild(o);
    });
  }

  async function lireSuivi() {
    var rs = await sb('/entretien_suivi?select=id,statut,date_prevue,date_faite,montant,note,maj_le');
    var n = Object.create(null);
    (rs || []).forEach(function (o) {
      n[o.id] = { statut: o.statut || 'a_faire', prevue: o.date_prevue || '',
                  faite: o.date_faite || '', montant: parseFloat(o.montant) || 0,
                  note: o.note || '', maj: o.maj_le || '' };
    });
    S = n;
  }

  function suivi(id) {
    if (!S[id]) S[id] = { statut: 'a_faire', prevue: '', faite: '', montant: 0, note: '', maj: '' };
    return S[id];
  }

  async function enregistrer(id) {
    var d = suivi(id);
    await sb('/entretien_suivi', {
      method: 'POST',
      corps: { id: id, statut: d.statut,
               date_prevue: d.prevue || null, date_faite: d.faite || null,
               montant: d.montant || 0, note: d.note || null },
      entetes: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }

  /* Le serveur pose la date du jour quand on déclare « terminé » sans date :
     on la relit pour que l'écran dise la même chose que la base. */
  async function enregistrerPuisRelire(id) {
    await enregistrer(id);
    var r = await sb('/entretien_suivi?select=date_faite,maj_le&id=eq.' + encodeURIComponent(id));
    if (r && r[0]) { suivi(id).faite = r[0].date_faite || ''; suivi(id).maj = r[0].maj_le || ''; }
  }

  /* ------------------------------------------------------------ filtres */
  function retenues() {
    var q = filtres.q.trim().toLowerCase();
    return DATA.filter(function (x) {
      var d = suivi(x.id);
      if (filtres.statut && d.statut !== filtres.statut) return false;
      if (filtres.rang && x.rang !== filtres.rang) return false;
      if (filtres.sect && x.secteur !== filtres.sect) return false;
      if (q && String(x.ecolePPI).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /* ------------------------------------------------------------- rendu */
  function enveloppe() {
    var n = { a_faire: 0, programme: 0, termine: 0, sans_suite: 0 };
    var m = { a_faire: 0, programme: 0, termine: 0, sans_suite: 0 }, total = 0;
    DATA.forEach(function (x) {
      var d = suivi(x.id);
      n[d.statut] = (n[d.statut] || 0) + 1;
      m[d.statut] = (m[d.statut] || 0) + (d.montant || 0);
      total += d.montant || 0;
    });
    var h = '';
    h += bloc('', 'À faire', n.a_faire, m.a_faire);
    h += bloc('prog', 'Programmées', n.programme, m.programme);
    h += bloc('fait', 'Terminées', n.termine, m.termine);
    h += bloc('', 'Sans suite', n.sans_suite, m.sans_suite);
    h += '<div class="tot"><div class="an">Total hors PPI</div>' +
         '<div class="mt">' + euro(total) + '</div>' +
         '<div class="nb">' + DATA.length + ' intervention' + (DATA.length > 1 ? 's' : '') + '</div></div>';
    $('#env').innerHTML = h;

    function bloc(cls, lib, nb, mt) {
      return '<div class="' + cls + '"><div class="an">' + lib + '</div>' +
             '<div class="mt">' + nb + '</div>' +
             '<div class="nb">' + (mt ? euro(mt) : '—') + '</div></div>';
    }
  }

  function ligne(x) {
    var d = suivi(x.id);
    var note = x.note != null && x.note !== '' ? x.note : null;
    var txt = (x.dem && x.dem.length)
      ? x.dem.map(function (q) { return (q.u ? '[' + q.u + '] ' : '') + q.d; }).join(' · ')
      : (x.obs || '');
    var ro = peutEcrire() ? '' : ' disabled';

    var boutons = STATUTS.map(function (st) {
      return '<button class="' + st.c + '" data-s="' + st.v + '" data-id="' + esc(x.id) + '" ' +
             'aria-pressed="' + (d.statut === st.v) + '"' + ro + '>' + st.l + '</button>';
    }).join('');

    return '<div class="ligne st-' + d.statut + '" data-l="' + esc(x.id) + '">' +
      '<div class="rg ' + (x.rang || 'x') + '">' + (x.rang || '—') + '</div>' +
      '<div class="ec">' + esc(x.ecolePPI) + '<small>' + esc(x.secteur || '') + '</small></div>' +
      '<div class="po">' + esc(x.poste) + '</div>' +
      '<div class="nt v' + (note == null ? 0 : note) + '">' + (note == null ? '—' : note) + '</div>' +
      '<div class="ctx">' + (txt ? '<span class="src">Constat</span>' + esc(txt) : '<span class="src">Sans précision</span>') + '</div>' +
      '<div class="dec"><div class="dgrp">' + boutons + '</div></div>' +
      '<div class="suite">' +
        '<label>Date prévue<input type="date" data-c="prevue" data-id="' + esc(x.id) + '" value="' + esc(d.prevue) + '"' + ro + '></label>' +
        '<label>Date réalisée<input type="date" data-c="faite" data-id="' + esc(x.id) + '" value="' + esc(d.faite) + '"' + ro + '></label>' +
        '<label>Montant (hors PPI)<input type="number" min="0" step="50" data-c="montant" data-id="' + esc(x.id) + '" value="' + (d.montant || '') + '" placeholder="0"' + ro + '></label>' +
        '<label class="libre">Observation<input type="text" data-c="note" data-id="' + esc(x.id) + '" value="' + esc(d.note) + '" placeholder="entreprise, difficulté rencontrée, suite à donner…"' + ro + '></label>' +
        (d.maj ? '<span class="faitle">mis à jour le ' + esc(String(d.maj).slice(0, 10).split('-').reverse().join('/')) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  function rendu() {
    enveloppe();
    var L = retenues();
    $('#liste').innerHTML = L.map(ligne).join('');
    $('#vide').classList.toggle('hidden', L.length > 0);
    $('#cnt').textContent = L.length + ' / ' + DATA.length + ' intervention' + (DATA.length > 1 ? 's' : '');
    $('#expVue').textContent = 'Exporter la liste affichée (' + L.length + ')';
  }

  /* Rafraîchir une seule ligne évite de perdre le curseur dans un champ
     pendant qu'on y écrit — ce que ferait un rendu complet. */
  /* CSS.escape() échappe pour un identifiant, pas pour une valeur d'attribut :
     il transformerait un point en « \. », qui ne correspondrait alors à rien
     entre guillemets. Les identifiants actuels n'ont que lettres, chiffres et
     tirets, mais la règle est ici la bonne, quoi qu'ils deviennent. */
  function selLigne(id) {
    return '.ligne[data-l="' + String(id).replace(/["\\]/g, '\\$&') + '"]';
  }
  function majLigne(id) {
    var el = document.querySelector(selLigne(id));
    if (!el) { rendu(); return; }
    var x = DATA.filter(function (o) { return o.id === id; })[0];
    if (!x) return;
    var tmp = document.createElement('div'); tmp.innerHTML = ligne(x);
    el.replaceWith(tmp.firstChild);
    enveloppe();
  }

  /* -------------------------------------------------------- interactions */
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('.dgrp button[data-s]');
    if (!b) return;
    if (!peutEcrire()) { etat('Votre compte est en lecture seule : le suivi est consultable, non modifiable.'); return; }
    var id = b.dataset.id, d = suivi(id);
    d.statut = b.dataset.s;
    // « Programmée » sans date prévue : on ouvre le champ plutôt que d'inventer.
    enregistrerPuisRelire(id).then(function () {
      majLigne(id);
      var f = filtres.statut;
      if (f && f !== d.statut) rendu();     // la ligne sort du filtre en cours
      etat(LIB[d.statut] + ' — enregistré.');
    }).catch(function (e) { etat(e.message, 6000); });
  });

  document.addEventListener('input', function (ev) {
    var c = ev.target.dataset && ev.target.dataset.c;
    if (!c) return;
    if (!peutEcrire()) return;
    var id = ev.target.dataset.id, d = suivi(id);
    if (c === 'montant') d.montant = parseFloat(ev.target.value) || 0;
    else d[c] = ev.target.value || '';
    // Une saisie au clavier ne doit pas provoquer un appel par caractère.
    clearTimeout(minuteurs[id + c]);
    minuteurs[id + c] = setTimeout(function () {
      enregistrer(id).then(function () { enveloppe(); })
                     .catch(function (e) { etat(e.message, 6000); });
    }, 700);
  });

  $$('.pill[data-f="statut"]').forEach(function (b) {
    b.addEventListener('click', function () {
      filtres.statut = b.dataset.v;
      $$('.pill[data-f="statut"]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o.dataset.v === filtres.statut)); });
      rendu();
    });
  });
  $('#frang').addEventListener('change', function () { filtres.rang = this.value; rendu(); });
  $('#fsect').addEventListener('change', function () { filtres.sect = this.value; rendu(); });
  $('#fq').addEventListener('input', function () { filtres.q = this.value; rendu(); });

  /* ------------------------------------------------------------ exports */
  function csv(lignes) {
    return '﻿' + lignes.map(function (l) {
      return l.map(function (c) {
        var v = c == null ? '' : String(c);
        return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(';');
    }).join('\r\n');
  }
  function telecharger(nom, contenu) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([contenu], { type: 'text/csv;charset=utf-8' }));
    a.download = nom; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function tableau(L) {
    var l = [['Ecole', 'Secteur', 'Poste', 'Note diagnostic', 'Priorite', 'Constat',
              'Avancement', 'Date prevue', 'Date realisee', 'Montant hors PPI', 'Observation']];
    L.forEach(function (x) {
      var d = suivi(x.id);
      var txt = (x.dem && x.dem.length) ? x.dem.map(function (q) { return q.d; }).join(' / ') : (x.obs || '');
      l.push([x.ecolePPI, x.secteur, x.poste, (x.note == null ? '' : x.note), x.rang, txt,
              LIB[d.statut], d.prevue || '', d.faite || '', d.montant || '', d.note || '']);
    });
    return l;
  }
  function nomDuFichier() {
    var p = ['Maintenance DTT'];
    if (filtres.statut) p.push(LIB[filtres.statut]);
    if (filtres.rang) p.push(filtres.rang);
    if (filtres.sect) p.push(filtres.sect);
    return p.join(' - ').replace(/[\\/:*?"<>|]/g, '') + '.csv';
  }
  $('#expVue').addEventListener('click', function () {
    var L = retenues();
    if (!L.length) { etat('La liste affichée est vide.'); return; }
    telecharger(nomDuFichier(), csv(tableau(L)));
    $('#notepan').textContent = L.length + ' intervention' + (L.length > 1 ? 's' : '') +
      ' exportée' + (L.length > 1 ? 's' : '') + ', telles que les filtres les désignent.';
  });
  $('#expTout').addEventListener('click', function () {
    if (!DATA.length) { etat('Aucune intervention confiée à la maintenance DTT.'); return; }
    telecharger('Maintenance DTT - tout.csv', csv(tableau(DATA)));
    $('#notepan').textContent = DATA.length + ' interventions exportées, filtres ignorés.';
  });

  /* ----------------------------------------------------------- connexion */
  $('#fconn').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    try { await Source.connecter($('#mail').value.trim());
          $('#noteconn').textContent = 'Lien envoyé. Ouvrez-le depuis ce poste.'; }
    catch (e) { $('#noteconn').textContent = e.message; }
  });

  /* Entrée par mot de passe : le jeton obtenu est rangé là où source.js
     range le sien, si bien que reprendreSession() le reprend et résout
     l'adresse et le rôle comme après un lien magique. */
  $('#fmdp').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    $('#noteconn').textContent = 'Connexion…';
    try {
      var r = await fetch(CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: CONFIG.SUPABASE_CLE_PUBLIQUE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#mail2').value.trim(), password: $('#mdp').value })
      });
      var d = await r.json();
      if (!r.ok || !d.access_token) {
        throw new Error(d.error_description || d.msg || 'Adresse ou mot de passe refusé.');
      }
      localStorage.setItem('ppi:session', JSON.stringify({
        token: d.access_token, refresh: d.refresh_token,
        expire: Math.floor(Date.now() / 1000) + (d.expires_in || 3600)
      }));
      location.reload();
    } catch (e) { $('#noteconn').textContent = e.message; }
  });

  function entete(s) {
    $('#qui').innerHTML = s
      ? '<b>' + esc(s.email || '') + '</b><span>· ' + esc(s.role || 'sans rôle') + '</span>' +
        '<button class="bt gh" id="sortir">Quitter</button>'
      : '';
    var b = document.getElementById('sortir');
    if (b) b.addEventListener('click', function () { Source.deconnecter(); location.reload(); });
  }

  /* ----------------------------------------------------------- démarrage */
  (async function () {
    var s = null;
    try { s = await Source.reprendreSession(); } catch (e) { etat(e.message, 6000); }
    entete(s);
    if (!s) {
      $('#connexion').classList.remove('hidden');
      $('#appli').classList.add('hidden');
      return;
    }
    try { await charger(); await lireSuivi(); }
    catch (e) { etat(e.message, 8000); return; }
    rendu();
    if (!DATA.length) {
      etat('Aucune intervention n’a encore été confiée à la maintenance DTT.', 5200);
    } else if (!peutEcrire()) {
      etat('Votre compte est en lecture seule : le suivi est consultable, non modifiable.', 5200);
    }
  })();
})();
