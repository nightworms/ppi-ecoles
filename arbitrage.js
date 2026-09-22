/* =====================================================================
   Arbitrage de la programmation — PPI Écoles
   ---------------------------------------------------------------------
   Lit le référentiel d'interventions (donnees/arbitrage-interventions.json),
   conserve les arbitrages dans la table « arbitrages » de Supabase, et verse
   les interventions retenues dans « operations » — c'est-à-dire dans le plan
   lui-même, via Source.enregistrerOperation().

   La page n'a besoin d'aucune modification de source.js : elle réutilise sa
   session et n'appelle la base directement que pour sa propre table.
   ===================================================================== */
(function () {
  'use strict';

  var ANNEES = [2027, 2028, 2029, 2030, 2031];
  var PROGS = ['Confort thermique', 'Gros entretien', 'Mise en sécurité',
               "Accessibilité Ad'AP", 'Maintenance'];

  var DATA = [], IDX = {}, A = Object.create(null);   // A : id -> arbitrage
  var ECOLE_ID = {};                                  // libellé PPI -> ecole_id
  var filtres = { rang: 'P1', dec: '', sect: '', poste: '', q: '' };
  var ouverts = Object.create(null), minuteurs = Object.create(null), enCours = Object.create(null);

  var $ = function (s) { return document.querySelector(s); };
  var euro = function (n) { return (Math.round(n) || 0).toLocaleString('fr-FR') + ' €'; };
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };

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
      var t = await r.text();
      if (r.status === 401 || r.status === 403) {
        var d = {}; try { d = JSON.parse(t); } catch (e) {}
        if (d.code === '42501' || /row-level security/i.test(t)) {
          throw new Error('La base refuse l’écriture : la règle d’accès de la table ' +
            '« arbitrages » ne reconnaît pas votre compte. Vérifiez que votre ligne de ' +
            'la table « membres » porte bien user_id = votre identifiant et role ' +
            '« admin » ou « redacteur ». (' + (d.message || '42501') + ')');
        }
        throw new Error('Accès refusé par la base : ' + (d.message || t.slice(0, 120)));
      }
      if (/relation .*arbitrages.* does not exist/i.test(t)) {
        throw new Error('La table « arbitrages » n’existe pas encore. ' +
          'Exécutez supabase/arbitrages.sql dans l’éditeur SQL de Supabase.');
      }
      throw new Error('Base de données : ' + r.status + ' ' + t.slice(0, 140));
    }
    return r.status === 204 ? null : r.json();
  }

  /* ------------------------------------------------------- chargements */
  async function charger() {
    var r = await fetch('donnees/arbitrage-interventions.json');
    if (!r.ok) throw new Error('Référentiel des interventions introuvable.');
    DATA = await r.json();
    DATA.forEach(function (x) { IDX[x.id] = x; });
    $('#ptot').textContent = DATA.length;

    var secteurs = {}, postes = {};
    DATA.forEach(function (x) { if (x.secteur) secteurs[x.secteur] = 1; postes[x.poste] = 1; });
    Object.keys(secteurs).sort().forEach(function (s) {
      var o = document.createElement('option'); o.value = s; o.textContent = s; $('#fsect').appendChild(o); });
    Object.keys(postes).sort().forEach(function (p) {
      var o = document.createElement('option'); o.value = p; o.textContent = p; $('#fposte').appendChild(o); });

    // correspondance libellé -> identifiant d'école, prise dans le plan lui-même
    try {
      (await Source.travaux()).forEach(function (t) {
        if (t.ecole && t.ecole_id != null && ECOLE_ID[t.ecole] == null) ECOLE_ID[t.ecole] = t.ecole_id; });
    } catch (e) { /* le plan n'est pas indispensable au chargement */ }
  }

  async function lireArbitrages() {
    var rs = await sb('/arbitrages?select=id,destination,annee,programme,montant,note,operation_id');
    var n = Object.create(null);
    rs.forEach(function (o) {
      n[o.id] = { dest: o.destination, annee: o.annee ? String(o.annee) : '',
                  prog: o.programme || '', montant: parseFloat(o.montant) || 0,
                  type: o.type_travaux || '', note: o.note || '', operation_id: o.operation_id };
    });
    A = n;
  }

  /* ---------------------------------------------------------- écriture */
  function enregistre(id) {
    var d = A[id];
    clearTimeout(minuteurs[id]);
    minuteurs[id] = setTimeout(async function () {
      if (enCours[id]) { minuteurs[id] = setTimeout(function () { enregistre(id); }, 400); return; }
      enCours[id] = true;
      try {
        if (!d.dest) {
          await sb('/arbitrages?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
          delete A[id];
        } else {
          await sb('/arbitrages', {
            method: 'POST',
            corps: { id: id, destination: d.dest, annee: d.annee ? parseInt(d.annee, 10) : null,
                     programme: d.prog || null, montant: d.montant || 0,
                     type_travaux: d.type || null, note: d.note || null,
                     operation_id: d.operation_id || null },
            entetes: { Prefer: 'resolution=merge-duplicates,return=minimal' }
          });
        }
      } catch (e) { etat(e.message, 5200); }
      enCours[id] = false;
    }, 350);
  }

  /* -------------------------------------------------------- enveloppes */
  function enveloppes() {
    var t = {}, n = {}, tot = 0, ntot = 0, dtt = 0, verse = 0;
    ANNEES.forEach(function (a) { t[a] = 0; n[a] = 0; });
    Object.keys(A).forEach(function (id) {
      var d = A[id];
      if (d.dest === 'ppi' && d.annee) {
        t[d.annee] = (t[d.annee] || 0) + (d.montant || 0);
        n[d.annee] = (n[d.annee] || 0) + 1; tot += d.montant || 0; ntot++;
        if (d.operation_id) verse++;
      } else if (d.dest === 'entretien') dtt++;
    });
    var h = '';
    ANNEES.forEach(function (a) {
      h += '<div><div class="an">' + a + '</div><div class="mt">' + euro(t[a]) + '</div>' +
           '<div class="nb">' + (n[a] || 0) + ' intervention' + (n[a] > 1 ? 's' : '') + '</div></div>';
    });
    h += '<div class="tot"><div class="an">Total PPI</div><div class="mt">' + euro(tot) + '</div>' +
         '<div class="nb">' + ntot + ' retenue' + (ntot > 1 ? 's' : '') +
         (verse ? ' · ' + verse + ' versée' + (verse > 1 ? 's' : '') : '') + '</div></div>';
    h += '<div class="dtt"><div class="an">Petit entretien</div><div class="mt">' + dtt + '</div>' +
         '<div class="nb">à transmettre à la DTT</div></div>';
    $('#env').innerHTML = h;
    $('#pfait').textContent = Object.keys(A).length;
  }

  /* ------------------------------------------------------------ rendu */
  function retenues() {
    return DATA.filter(function (x) {
      var d = A[x.id] || {};
      if (filtres.rang && x.rang !== filtres.rang) return false;
      if (filtres.dec === '0' && d.dest) return false;
      if (filtres.dec === 'verse' && !d.operation_id) return false;
      if (filtres.dec && filtres.dec !== '0' && filtres.dec !== 'verse' && d.dest !== filtres.dec) return false;
      if (filtres.sect && x.secteur !== filtres.sect) return false;
      if (filtres.poste && x.poste !== filtres.poste) return false;
      if (filtres.q && (x.ecole + ' ' + x.poste).toLowerCase().indexOf(filtres.q) < 0) return false;
      return true;
    });
  }

  function ligne(x) {
    var d = A[x.id] || {}, cls = 'ligne';
    if (d.dest === 'ppi') cls += ' ppi'; else if (d.dest === 'entretien') cls += ' entretien';
    else if (d.dest === 'ecarte') cls += ' ecarte';
    if (d.operation_id) cls += ' verse';
    var h = '<article class="' + cls + '" data-id="' + x.id + '">';
    h += '<div class="rg ' + (x.rang === '—' ? 'x' : x.rang) + '" title="score ' + x.score + '">' +
         (x.rang === '—' ? '·' : x.rang) + '</div>';
    h += '<div class="ec">' + esc(x.ecole) + '<small>' + esc(x.secteur || '—') + '</small></div>';
    h += '<div class="po">' + esc(x.poste) + '</div>';
    h += '<div class="nt v' + (x.note || 0) + '">' + (x.note || '–') + '</div>';

    var c = '';
    if (x.origine === 'ppi') c += '<span class="src">plan</span>Ligne inscrite sans poste correspondant';
    else if (x.dem && x.dem.length) c += '<span class="src">école</span>' + esc(x.dem[0].d.slice(0, 110)) + (x.dem[0].d.length > 110 ? '…' : '');
    else if (x.obs) c += '<span class="src">technicien</span>' + esc(x.obs.slice(0, 110)) + (x.obs.length > 110 ? '…' : '');
    else c += '<span class="src">—</span>aucune observation';
    if (x.ligne) c += ' <span class="src" style="margin-left:7px">plan</span>' + x.ligne.annee + ' · ' + euro(x.ligne.montant);
    if (d.operation_id) c += ' <span class="src" style="margin-left:7px;color:var(--accent4)">versée au plan</span>';
    c += ' <button data-plus="' + x.id + '">' + (ouverts[x.id] ? 'moins' : 'détail') + '</button>';
    h += '<div class="ctx">' + c + '</div>';

    h += '<div class="dec">';
    h += '<div class="dgrp">' +
         '<button data-d="ppi" data-id="' + x.id + '" aria-pressed="' + (d.dest === 'ppi') + '">PPI</button>' +
         '<button class="d2" data-d="entretien" data-id="' + x.id + '" aria-pressed="' + (d.dest === 'entretien') + '">Entretien</button>' +
         '<button class="d3" data-d="ecarte" data-id="' + x.id + '" aria-pressed="' + (d.dest === 'ecarte') + '">Écarter</button>' +
         '</div>';
    if (d.dest === 'ppi') {
      var fige = d.operation_id ? ' disabled' : '';
      h += '<select data-c="annee" data-id="' + x.id + '"' + fige + (d.annee ? '' : ' class="manque"') + '><option value="">année…</option>';
      ANNEES.forEach(function (a) { h += '<option value="' + a + '"' + (d.annee == a ? ' selected' : '') + '>' + a + '</option>'; });
      h += '</select>';
      var typeOk = d.type || (x.type !== 'Autre' ? x.type : '');
      h += '<select data-c="type" data-id="' + x.id + '"' + fige + (typeOk ? '' : ' class="manque"') +
           '><option value="">type de travaux…</option>';
      (Source.TYPES_TRAVAUX || []).forEach(function (t) {
        h += '<option value="' + esc(t) + '"' + (typeOk === t ? ' selected' : '') + '>' + esc(t) + '</option>'; });
      h += '</select>';
      h += '<select data-c="prog" data-id="' + x.id + '"' + fige + '><option value="">thématique…</option>';
      PROGS.forEach(function (p) { h += '<option value="' + esc(p) + '"' + (d.prog === p ? ' selected' : '') + '>' + esc(p) + '</option>'; });
      h += '</select>';
      h += '<input type="number" step="1000" min="0" placeholder="montant" data-c="montant" data-id="' + x.id +
           '" value="' + (d.montant || '') + '" aria-label="Montant en euros"' + fige + (d.montant ? '' : ' class="manque"') + '>';
    }
    h += '</div>';

    if (ouverts[x.id]) {
      h += '<div class="detail">';
      if (x.obs) h += '<div><span class="tag">Constat du technicien · note ' + (x.note || '–') +
                      (x.photos ? ' · ' + x.photos + ' photo' + (x.photos > 1 ? 's' : '') : '') + '</span>' + esc(x.obs) + '</div>';
      if (x.dem && x.dem.length) {
        x.dem.slice(0, 6).forEach(function (dm) {
          h += '<div><span class="tag">Conseil d\'école' + (dm.u ? ' · ' + esc(dm.u) : '') +
               (x.anc ? ' · depuis ' + x.anc : '') + '</span>' + esc(dm.d) + '</div>'; });
        if (x.dem.length > 6) h += '<div style="color:var(--text-dim)">et ' + (x.dem.length - 6) + ' autre(s) demande(s) sur ce poste.</div>';
      }
      if (x.ligne) h += '<div><span class="tag">Ligne existante au plan</span><b>' + x.ligne.annee + '</b> · ' +
                        euro(x.ligne.montant) + ' · ' + esc(x.ligne.etat) + ' · ' + esc(x.ligne.programme) + '</div>';
      h += '<div><span class="tag">Report vers le plan</span>Libellé : <b>' + esc(x.ecolePPI) + '</b>' +
           (ECOLE_ID[x.ecolePPI] != null ? '' : ' <em>(école non reconnue au référentiel : la ligne sera créée sans rattachement)</em>') +
           ' · Type : <b>' + esc((A[x.id] && A[x.id].type) || x.type) + '</b>' +
           (x.type === 'Autre' && !(A[x.id] && A[x.id].type) ? ' <em>(à choisir : aucun type ne découle du poste)</em>' : '') +
           ' · Statut : ' + esc(x.statut) + ' · Score ' + x.score + '</div>';
      h += '</div>';
    }
    return h + '</article>';
  }

  function rendu() {
    var L = retenues();
    $('#cnt').textContent = L.length + ' intervention' + (L.length > 1 ? 's' : '') + ' affichée' + (L.length > 1 ? 's' : '');
    $('#vide').classList.toggle('hidden', L.length > 0);
    var lim = L.slice(0, 300);
    var h = lim.map(ligne).join('');
    if (L.length > lim.length) h += '<div class="vide">' + (L.length - lim.length) +
      ' autres interventions correspondent — affinez les filtres pour les atteindre.</div>';
    $('#liste').innerHTML = h;
    enveloppes();
  }

  /* ---------------------------------------------------- interactions */
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.f === 'rang') {
      filtres.rang = b.dataset.v;
      document.querySelectorAll('[data-f="rang"]').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x === b)); });
      rendu(); return;
    }
    if (b.dataset.plus) { ouverts[b.dataset.plus] = !ouverts[b.dataset.plus]; rendu(); return; }
    if (b.dataset.d) {
      var id = b.dataset.id, d = A[id] || {};
      if (d.operation_id) { etat('Cette intervention est déjà versée au plan : modifiez l’opération dans le tableau de bord.'); return; }
      if (!Source.peutEcrire()) { etat(Source.refusEcriture()); return; }
      A[id] = d; d.dest = (d.dest === b.dataset.d) ? '' : b.dataset.d;
      if (d.dest !== 'ppi') { d.annee = ''; d.prog = ''; d.montant = 0; }
      enregistre(id); rendu(); return;
    }
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target, id = el.dataset && el.dataset.id;
    if (el.id === 'fdec') { filtres.dec = el.value; rendu(); return; }
    if (el.id === 'fsect') { filtres.sect = el.value; rendu(); return; }
    if (el.id === 'fposte') { filtres.poste = el.value; rendu(); return; }
    if (!id || !el.dataset.c) return;
    A[id] = A[id] || {};
    if (el.dataset.c === 'montant') A[id].montant = parseInt(el.value || '0', 10) || 0;
    else A[id][el.dataset.c] = el.value;
    enregistre(id); enveloppes();
  });
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.id === 'fq') { filtres.q = el.value.trim().toLowerCase(); rendu(); return; }
    if (el.dataset && el.dataset.c === 'montant') {
      var id = el.dataset.id; A[id] = A[id] || {};
      A[id].montant = parseInt(el.value || '0', 10) || 0;
      enregistre(id); enveloppes();
    }
  });

  /* --------------------------------------------- versement au plan */
  $('#verser').addEventListener('click', async function () {
    if (!Source.peutEcrire()) { etat(Source.refusEcriture()); return; }
    var prets = DATA.filter(function (x) {
      var d = A[x.id];
      return d && d.dest === 'ppi' && d.annee && d.montant > 0 && !d.operation_id &&
             (d.type || x.type !== 'Autre'); });
    if (!prets.length) { etat('Aucune intervention prête : il faut une année, un montant et un type de travaux.'); return; }
    if (!confirm('Verser ' + prets.length + ' intervention' + (prets.length > 1 ? 's' : '') +
                 ' au plan d’investissement ?\nElles deviendront des opérations visibles de tous.')) return;
    var b = this; b.disabled = true;
    var ok = 0, ko = 0;
    for (var i = 0; i < prets.length; i++) {
      var x = prets[i], d = A[x.id];
      b.textContent = 'Versement ' + (i + 1) + ' / ' + prets.length + '…';
      try {
        var op = { ecole_libelle: x.ecolePPI, secteur: x.secteur || '', programme: d.prog || '',
                   annee: parseInt(d.annee, 10), type: d.type || x.type, montant: d.montant,
                   etat: 'planifie',
                   notes: 'Arbitrage ' + new Date().toLocaleDateString('fr-FR') + ' — ' + x.poste +
                          ' — priorité ' + x.rang + ' (score ' + x.score + ')' };
        if (ECOLE_ID[x.ecolePPI] != null) op.ecole_id = ECOLE_ID[x.ecolePPI];
        var cree = await Source.enregistrerOperation(op);
        var oid = (cree && cree[0] && cree[0].id) || null;
        d.operation_id = oid;
        await sb('/arbitrages', { method: 'POST',
          corps: { id: x.id, destination: 'ppi', annee: parseInt(d.annee, 10), programme: d.prog || null,
                   montant: d.montant, note: d.note || null, operation_id: oid },
          entetes: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
        ok++;
      } catch (e) { ko++; }
    }
    b.disabled = false; b.textContent = 'Verser au plan les interventions prêtes';
    $('#notepan').textContent = ok + ' opération' + (ok > 1 ? 's' : '') + ' créée' + (ok > 1 ? 's' : '') +
      ' dans le plan' + (ko ? ' · ' + ko + ' en échec, réessayez.' : '.');
    etat(ok + ' intervention' + (ok > 1 ? 's' : '') + ' versée' + (ok > 1 ? 's' : '') + ' au plan.', 4200);
    rendu();
  });

  /* ------------------------------------------------------- exports */
  function csv(lignes) {
    return '﻿' + lignes.map(function (r) {
      return r.map(function (v) { v = (v == null ? '' : String(v)); return '"' + v.replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
  }
  function telecharger(nom, contenu) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([contenu], { type: 'text/csv;charset=utf-8' }));
    a.download = nom; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  $('#expDTT').addEventListener('click', function () {
    var l = [['Ecole', 'Secteur', 'Poste', 'Note diagnostic', 'Demande ou constat', 'Priorite']], n = 0;
    DATA.forEach(function (x) {
      var d = A[x.id]; if (!d || d.dest !== 'entretien') return;
      var txt = (x.dem && x.dem.length) ? x.dem.map(function (q) { return q.d; }).join(' / ') : (x.obs || '');
      l.push([x.ecolePPI, x.secteur, x.poste, x.note || '', txt, x.rang]); n++;
    });
    if (!n) { etat('Aucune intervention orientée vers le petit entretien.'); return; }
    telecharger('Petit entretien - Direction des travaux du territoire.csv', csv(l));
    $('#notepan').textContent = n + ' ligne' + (n > 1 ? 's' : '') + ' exportée' + (n > 1 ? 's' : '') + ' pour la DTT.';
  });
  $('#expCSV').addEventListener('click', function () {
    var l = [['Ecole', 'Secteur', 'Poste', 'Type', 'Priorite', 'Score', 'Destination', 'Annee', 'Programme', 'Montant', 'Versee au plan']];
    DATA.forEach(function (x) {
      var d = A[x.id]; if (!d || !d.dest) return;
      l.push([x.ecolePPI, x.secteur, x.poste, x.type, x.rang, x.score, d.dest, d.annee || '',
              d.prog || '', d.montant || 0, d.operation_id ? 'oui' : 'non']);
    });
    if (l.length < 2) { etat('Aucun arbitrage à exporter.'); return; }
    telecharger('Arbitrage programmation.csv', csv(l));
  });

  /* ----------------------------------------------------- démarrage */
  $('#fconn').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    try { await Source.connecter($('#mail').value.trim());
          $('#noteconn').textContent = 'Lien envoyé. Ouvrez-le depuis ce poste.'; }
    catch (e) { $('#noteconn').textContent = e.message; }
  });

  function entete(s) {
    $('#qui').innerHTML = s
      ? '<b>' + esc(s.email || '') + '</b><span>· ' + esc(s.role || 'sans rôle') + '</span>' +
        '<button class="bt gh" id="sortir">Quitter</button>'
      : '';
    var b = document.getElementById('sortir');
    if (b) b.addEventListener('click', function () { Source.deconnecter(); location.reload(); });
  }

  (async function () {
    try {
      await charger();
    } catch (e) { etat(e.message, 6000); return; }

    var s = null;
    try { s = await Source.reprendreSession(); } catch (e) { etat(e.message, 6000); }
    entete(s);
    if (!s) {
      $('#connexion').classList.remove('hidden');
      $('#appli').classList.add('hidden');
      return;
    }
    try { await lireArbitrages(); }
    catch (e) { etat(e.message, 6000); }
    rendu();
    if (!Source.peutEcrire()) etat('Votre compte est en lecture seule : les arbitrages sont consultables, non modifiables.', 5200);
  })();
})();
