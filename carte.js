/* =====================================================================
   Vue Carte — les opérations PPI situées sur les 77 écoles de la commune
   ---------------------------------------------------------------------
   Les opérations viennent du module Source ; le fond de plan et le
   référentiel géographique sont des fichiers du dépôt. Rien n'est écrit :
   la saisie reste dans la feuille jusqu'à la bascule Supabase.
   ===================================================================== */
window.Carte = (function () {
  'use strict';

  // --- couleurs, reprises du tableau de bord ---------------------------
  // Chaque état a deux teintes : l'une pour le fond sombre du tableau de bord,
  // l'autre pour le fond clair de la carte, où les tons pâles disparaîtraient.
  var ETATS = {
    realise:  { nom: 'Réalisé',      c: '#6ab04c', cc: '#3d7a1e' },
    cours:    { nom: 'En cours',     c: '#3ecfcf', cc: '#0b6f86' },
    consult:  { nom: 'Consultation', c: '#a78bfa', cc: '#6a3d92' },
    planifie: { nom: 'Planifié',     c: '#7a8fa6', cc: '#4a6570' },
    urgent:   { nom: 'Urgent',       c: '#e05c5c', cc: '#a13328' },
    reporte:  { nom: 'Reporté',      c: '#f0a500', cc: '#a8620d' }
  };
  // Les quatre degrés d'attention du PPI. Mêmes libellés et mêmes couleurs que
  // l'onglet Alertes : une alerte doit se reconnaître d'un écran à l'autre.
  var NIVEAUX = {
    urgence:   { nom: 'Urgence',     ic: '🚨', c: '#e05c5c' },
    vigilance: { nom: 'Vigilance',   ic: '⚠',  c: '#f0a500' },
    decision:  { nom: 'Décision',    ic: 'ℹ',  c: '#3ecfcf' },
    info:      { nom: 'Information', ic: '💬', c: '#7a8fa6' }
  };
  var TEINTES  = ['#f0a500', '#3ecfcf', '#6ab04c', '#bb96e0', '#e05c5c',
                  '#93aeea', '#e191bf', '#9fbac5', '#d98f5a', '#7fc98a', '#c9b458'];
  var TEINTES_C = ['#a8620d', '#0b6f86', '#3d7a1e', '#6a3d92', '#a13328',
                   '#2c4f9c', '#97316b', '#4a6570', '#8a4b1f', '#2f6d35', '#7a6a12'];
  var couleursType = {}, couleursTypeC = {};   // remplis à la lecture des opérations
  var theme = 'clair';                          // fond de carte : 'clair' | 'sombre'
  var calques = { bati: true, voirie: true, rues: true, planches: true };

  // Relevé des planches ArcMap : deux dispositifs que le PPI ne suit pas. Ils sont
  // dessinés en couronne autour du disque, pour ne pas se confondre avec les
  // opérations PPI qui, elles, en occupent les secteurs.
  var PLANCHES = {
    pergolas:       { nom: 'Pergolas',      c: '#e0a552', cc: '#a8620d' },
    vegetalisation: { nom: 'Végétalisation', c: '#8bc25f', cc: '#3d7a1e' }
  };
  function couleurPlanche(k) {
    var d = PLANCHES[k]; return theme === 'clair' ? d.cc : d.c;
  }

  // --- rapprochement des noms -----------------------------------------
  var PREFIXES = { 'mat': 'Maternelle', 'elem': 'Élémentaire', 'elém': 'Élémentaire',
                   'élém': 'Élémentaire', 'prim': 'Primaire', 'annexe': 'Autre' };
  // Abréviations du PPI ramenées à la forme du référentiel. « jean » et « noirs »
  // sont neutralisés : « Prim JB Bossard » et « Elém. Les Lilas » désignent bien
  // « Jean-Baptiste Bossard » et « Les Lilas - Bois Noirs ».
  var ABREGES = { g: 'gabriel', h: 'henri', jb: 'bossard', st: 'saint', ste: 'sainte',
                  appl: 'application', appli: 'application', phil: 'philibert',
                  philip: 'philippe', pit: 'piton', b: 'bois', joinvile: 'joinville',
                  jean: '', baptiste: 'bossard', noirs: '' };
  var IGNORES = { pk7: 1, '15e': 1, '8e': 1, '15': 1, '8': 1, annexe: 1 };
  // « mat », « elem », « prim » : préfixes de niveau du PPI, déjà lus par niveauPPI.
  var VIDES = { ecole: 1, ecoles: 1, maternelle: 1, elementaire: 1, primaire: 1,
                application: 1, les: 1, la: 1, le: 1, de: 1, du: 1, des: 1, d: 1, l: 1,
                mat: 1, elem: 1, prim: 1 };

  function sansAccent(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function motsDe(t) {
    return sansAccent(t).replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function (w) { return w && !VIDES[w] && !IGNORES[w]; })
      // hasOwnProperty et non « || » : certains alias valent la chaîne vide,
      // qui doit neutraliser le mot plutôt que le laisser passer.
      .map(function (w) { return ABREGES.hasOwnProperty(w) ? ABREGES[w] : w; })
      .filter(function (w) { return w && !VIDES[w]; });
  }
  function ensemble(t) {
    var o = {}; motsDe(t).forEach(function (w) { o[w] = 1; }); return Object.keys(o);
  }
  function niveauPPI(nom) {
    var p = sansAccent(nom).trim().split(/[\s.]+/)[0];
    return PREFIXES[p] || 'Autre';
  }
  function compatibles(a, b) {
    return a === b || a === 'Autre' || b === 'Autre' || a === 'Primaire' || b === 'Primaire';
  }
  function score(a, b) {
    var A = ensemble(a), B = ensemble(b);
    if (!A.length || !B.length) return 0;
    var n = A.filter(function (w) { return B.indexOf(w) >= 0; }).length;
    return n / Math.max(A.length, B.length);
  }

  /* Une opération n'est « non située » que si rien ne la place : ni le
     rattachement stocké en base, ni l'appariement par le nom. Sans ce tri, une
     opération créée depuis la carte pour une école au libellé inhabituel serait
     signalée perdue alors qu'elle figure au bon endroit. */
  function vraimentOrphelines(operations, app) {
    var sansPlace = {};
    operations.forEach(function (o) {
      if (!(o.ecole_id || app.table[o.ecole])) sansPlace[o.ecole] = 1;
    });
    return app.orphelines.filter(function (x) { return sansPlace[x.nom]; });
  }

  /* Associe chaque nom d'école du PPI à une école du référentiel. */
  function apparier(operations, ecoles) {
    var table = {}, orphelines = [], approx = [];
    var noms = {};
    operations.forEach(function (o) { noms[o.ecole] = 1; });
    Object.keys(noms).forEach(function (nom) {
      var niv = niveauPPI(nom), meilleur = null, best = 0;
      ecoles.forEach(function (e) {
        var s = score(nom, e.court);
        if (compatibles(niv, e.niveau)) s += 0.25;
        if (s > best) { best = s; meilleur = e; }
      });
      if (!meilleur || best < 0.75) {
        orphelines.push({ nom: nom, meilleur: meilleur ? meilleur.nom : null,
                          score: Math.round(best * 100) / 100 });
        return;
      }
      table[nom] = meilleur.id;
      // Même nom mais niveau différent : l'opération est posée au bon endroit,
      // mais l'école n'existe pas telle quelle au référentiel. À signaler.
      if (!compatibles(niv, meilleur.niveau)) {
        approx.push({ nom: nom, niveau: niv, carte: meilleur.nom });
      }
    });
    return { table: table, orphelines: orphelines, approx: approx };
  }

  // --- projection ------------------------------------------------------
  var B, PW, PH, svg, gRoot, gMark, gRues, gBati, gVoirie, vue = { x: 0, y: 0, k: 1 };

  /* ==================================================================
     Vue aérienne — orthophotographie de l'IGN
     ------------------------------------------------------------------
     La carte projette linéairement latitude et longitude ; c'est très
     exactement ce que rend un WMS en EPSG:4326. L'image se pose donc sur
     le plan sans reprojection, au pixel près.

     Service public, sans clé ni compte : data.geopf.fr. Google Maps
     aurait demandé une clé, un compte de facturation, et interdit de
     superposer ses tuiles à un dessin fait ailleurs.
     ================================================================== */
  var ORTHO_WMS = 'https://data.geopf.fr/wms-r/wms';
  var ORTHO_COUCHE = 'ORTHOIMAGERY.ORTHOPHOTOS';
  var gOrtho = null, orthoAttente = null, orthoDerniere = '';

  function lonDe(x) { return B.lo0 + x / PW * (B.lo1 - B.lo0); }
  function latDe(y) { return B.la1 - y / PH * (B.la1 - B.la0); }

  function urlOrtho(x0, y0, w, h, px, py) {
    // WMS 1.3.0 en EPSG:4326 : l'ordre des axes est latitude puis longitude.
    var bbox = [latDe(y0 + h), lonDe(x0), latDe(y0), lonDe(x0 + w)]
                 .map(function (v) { return v.toFixed(6); }).join(',');
    return ORTHO_WMS + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
      '&LAYERS=' + ORTHO_COUCHE + '&STYLES=&FORMAT=image/jpeg&CRS=EPSG:4326' +
      '&BBOX=' + bbox + '&WIDTH=' + Math.round(px) + '&HEIGHT=' + Math.round(py);
  }

  /* On demande l'image de la portion visible, à la définition de l'écran :
     une seule image pour toute la commune serait floue dès qu'on zoome. */
  function majOrtho(immediat) {
    if (!gOrtho) return;
    if (theme !== 'photo') {
      // On oublie la dernière adresse en même temps qu'on efface l'image :
      // sans cela, revenir à la vue aérienne se heurterait au test « même
      // adresse qu'avant » et laisserait le fond vide.
      gOrtho.setAttribute('href', ''); orthoDerniere = '';
      return;
    }
    clearTimeout(orthoAttente);
    var essais = 0;
    var faire = function () {
      var r = svg.getBoundingClientRect();
      // La carte peut n'avoir aucune mise en page au moment du basculement —
      // onglet qui vient de s'afficher, fenêtre redimensionnée. On réessaie
      // à la trame suivante plutôt que d'abandonner sans image.
      if (r.width < 2) {
        if (essais++ < 60) requestAnimationFrame(faire);
        return;
      }
      // Une marge d'un quart d'écran évite un bord blanc au premier
      // déplacement, le temps que la nouvelle image arrive.
      var mx = r.width / vue.k * 0.25, my = r.height / vue.k * 0.25;
      var x0 = -vue.x / vue.k - mx, y0 = -vue.y / vue.k - my;
      var w = r.width / vue.k + 2 * mx, h = r.height / vue.k + 2 * my;
      var lp = Math.min(2048, Math.round(r.width * 1.5));
      var hp = Math.max(1, Math.round(lp * h / w));
      var u = urlOrtho(x0, y0, w, h, lp, hp);
      if (u === orthoDerniere) return;
      orthoDerniere = u;
      gOrtho.setAttribute('x', x0); gOrtho.setAttribute('y', y0);
      gOrtho.setAttribute('width', w); gOrtho.setAttribute('height', h);
      gOrtho.setAttribute('href', u);
    };
    if (immediat) faire(); else orthoAttente = setTimeout(faire, 260);
  }
  function px(lon) { return (lon - B.lo0) / (B.lo1 - B.lo0) * PW; }
  function py(lat) { return (B.la1 - lat) / (B.la1 - B.la0) * PH; }
  function ns(t) { return document.createElementNS('http://www.w3.org/2000/svg', t); }
  function trace(anneau, ferme) {
    return 'M' + anneau.map(function (p) {
      return px(p[1]).toFixed(1) + ' ' + py(p[0]).toFixed(1);
    }).join('L') + (ferme ? 'Z' : '');
  }

  // --- état de la vue --------------------------------------------------
  var D = { ecoles: [], fond: null, etiq: [], ops: [], parEcole: {},
            orphelines: [], approx: [] };
  var filtre = { annee: '', programme: '', type: '', etat: '', secteur: '',
                 niveau: '', planches: '', q: '' };
  var colorerPar = 'etat';
  var selection = null, pret = false;

  function opsVisibles(e) {
    return (D.parEcole[e.id] || []).filter(function (o) {
      return (!filtre.annee || String(o.annee) === filtre.annee)
          && (!filtre.programme || o.programme === filtre.programme)
          && (!filtre.type || o.type === filtre.type)
          && (!filtre.etat || o.etat === filtre.etat);
    });
  }
  function ecolesVisibles() {
    return D.ecoles.filter(function (e) {
      if (filtre.secteur && e.q !== filtre.secteur) return false;
      if (filtre.niveau && e.niveau !== filtre.niveau) return false;
      if (filtre.q && sansAccent(e.nom + ' ' + e.q).indexOf(sansAccent(filtre.q)) < 0) return false;
      if (filtre.planches && !(e.planches && e.planches[filtre.planches])) return false;
      if (opsVisibles(e).length) return true;
      if (filtre.planches) return true;   // le relevé des planches suffit à montrer l'école
      // sans opération : visible seulement si aucun filtre de contenu n'est posé
      return !filtre.annee && !filtre.programme && !filtre.type && !filtre.etat;
    });
  }
  function couleurOp(o) {
    var clair = theme === 'clair';
    if (colorerPar === 'etat') {
      var e = ETATS[o.etat] || ETATS.planifie;
      return clair ? e.cc : e.c;
    }
    return (clair ? couleursTypeC : couleursType)[o.type] || (clair ? '#4a6570' : '#7a8fa6');
  }

  // --- dessin ----------------------------------------------------------
  function fondDePlan() {
    svg.textContent = '';
    gRoot = ns('g'); svg.appendChild(gRoot);
    var f = D.fond;
    // L'orthophotographie se glisse sous tout le reste.
    gOrtho = ns('image'); gOrtho.setAttribute('class', 'c-ortho');
    gOrtho.setAttribute('preserveAspectRatio', 'none');
    gRoot.appendChild(gOrtho);
    var mer = ns('path'); mer.setAttribute('class', 'c-mer');
    mer.setAttribute('d', f.mer.map(function (r) { return trace(r, true); }).join(' '));
    gRoot.appendChild(mer);

    var gq = ns('g'); gq.setAttribute('class', 'c-quartiers'); gRoot.appendChild(gq);
    f.quartiers.forEach(function (r) {
      var p = ns('path'); p.setAttribute('d', trace(r.p, true)); gq.appendChild(p);
    });
    var gv = ns('g'); gv.setAttribute('class', 'c-voisins'); gRoot.appendChild(gv);
    f.voisins.forEach(function (r) {
      var p = ns('path'); p.setAttribute('d', trace(r, true)); gv.appendChild(p);
    });

    var C = f.bati_dim.coins, W = f.bati_dim.w, H = f.bati_dim.h;
    var P = function (c) { return [px(c[1]), py(c[0])]; };
    var no = P(C[0]), nea = P(C[1]), so = P(C[3]);
    var img = ns('image');
    img.setAttribute('width', W); img.setAttribute('height', H);
    img.setAttribute('x', 0); img.setAttribute('y', 0);
    img.setAttribute('preserveAspectRatio', 'none');
    img.setAttribute('transform', 'matrix(' + [
      (nea[0] - no[0]) / W, (nea[1] - no[1]) / W,
      (so[0] - no[0]) / H, (so[1] - no[1]) / H, no[0], no[1]
    ].map(function (v) { return v.toFixed(6); }).join(',') + ')');
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', 'donnees/bati.png');
    img.setAttribute('class', 'c-bati');
    gBati = img; gRoot.appendChild(img);

    var vo = ns('path'); vo.setAttribute('class', 'c-voirie');
    vo.setAttribute('d', f.routes.map(function (r) { return trace(r, false); }).join(''));
    gVoirie = vo; gRoot.appendChild(vo);

    var gt = ns('g'); gt.setAttribute('class', 'c-traits'); gRoot.appendChild(gt);
    f.quartiers.forEach(function (r) {
      var p = ns('path'); p.setAttribute('d', trace(r.p, true)); gt.appendChild(p);
    });
    var gl = ns('g'); gl.setAttribute('class', 'c-etiq'); gRoot.appendChild(gl);
    D.etiq.forEach(function (q) {
      var t = ns('text'), lignes = replier(q.n, 15);
      t.setAttribute('x', px(q.lon).toFixed(1)); t.setAttribute('y', py(q.lat).toFixed(1));
      lignes.forEach(function (l, i) {
        var ts = ns('tspan');
        ts.setAttribute('x', px(q.lon).toFixed(1));
        ts.setAttribute('dy', i === 0 ? (-(lignes.length - 1) * 0.55) + 'em' : '1.1em');
        ts.textContent = l; t.appendChild(ts);
      });
      gl.appendChild(t);
    });
    gRues = ns('g'); gRues.setAttribute('class', 'c-rues'); gRoot.appendChild(gRues);
    gMark = ns('g'); gMark.setAttribute('class', 'c-marques'); gRoot.appendChild(gMark);
  }
  function replier(t, n) {
    var out = [], cur = '';
    t.split(' ').forEach(function (m) {
      if (cur && (cur + ' ' + m).length > n) { out.push(cur); cur = m; }
      else cur = cur ? cur + ' ' + m : m;
    });
    if (cur) out.push(cur);
    return out;
  }

  function secteur(cx, cy, r, i, n) {
    if (n === 1) return 'M' + (cx - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 0 ' +
                        (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0';
    var a0 = -Math.PI / 2 + i * 2 * Math.PI / n, a1 = -Math.PI / 2 + (i + 1) * 2 * Math.PI / n;
    return 'M' + cx.toFixed(2) + ' ' + cy.toFixed(2) +
           'L' + (cx + r * Math.cos(a0)).toFixed(2) + ' ' + (cy + r * Math.sin(a0)).toFixed(2) +
           'A' + r + ' ' + r + ' 0 0 1 ' +
           (cx + r * Math.cos(a1)).toFixed(2) + ' ' + (cy + r * Math.sin(a1)).toFixed(2) + 'Z';
  }

  var montantMax = 1;
  function rayon(total, k) {
    var base = 6 + 12 * Math.sqrt(Math.min(total, montantMax) / montantMax);
    return (total > 0 ? base : 6) / k;
  }

  function marques() {
    if (!gMark) return;
    gMark.textContent = '';
    var k = vue.k, liste = ecolesVisibles();
    liste.forEach(function (e) {
      var ops = opsVisibles(e);
      var total = ops.reduce(function (s, o) { return s + (o.montant || 0); }, 0);
      var cx = px(e.lon), cy = py(e.lat), r = rayon(total, k);
      var g = ns('g');
      g.setAttribute('class', 'c-mk' + (selection === e.id ? ' sel' : ''));
      g.dataset.id = e.id;
      var zone = ns('circle');
      zone.setAttribute('cx', cx); zone.setAttribute('cy', cy);
      zone.setAttribute('r', (r + 3 / k).toFixed(2));
      zone.setAttribute('class', 'c-zone'); g.appendChild(zone);
      if (selection === e.id) {
        var h = ns('circle');
        h.setAttribute('cx', cx); h.setAttribute('cy', cy);
        h.setAttribute('r', (r + 5 / k).toFixed(2));
        h.setAttribute('class', 'c-halo'); g.appendChild(h);
      }
      // couronne du relevé des planches
      var pk = calques.planches && e.planches ? Object.keys(e.planches) : [];
      if (filtre.planches) pk = pk.filter(function (x) { return x === filtre.planches; });
      pk.forEach(function (kk, i) {
        var rr = r + 4 / k, ecart = 0.12;
        var a0 = -Math.PI / 2 + i * 2 * Math.PI / pk.length + ecart;
        var a1 = -Math.PI / 2 + (i + 1) * 2 * Math.PI / pk.length - ecart;
        var arc = ns('path');
        var grand = (a1 - a0) > Math.PI ? 1 : 0;
        arc.setAttribute('d', 'M' + (cx + rr * Math.cos(a0)).toFixed(2) + ' ' +
          (cy + rr * Math.sin(a0)).toFixed(2) + 'A' + rr.toFixed(2) + ' ' + rr.toFixed(2) +
          ' 0 ' + grand + ' 1 ' + (cx + rr * Math.cos(a1)).toFixed(2) + ' ' +
          (cy + rr * Math.sin(a1)).toFixed(2));
        arc.setAttribute('class', 'c-planche');
        arc.setAttribute('stroke', couleurPlanche(kk));
        arc.setAttribute('stroke-dasharray', e.planches[kk].s === 'realise' ? '' : '3 2.5');
        g.appendChild(arc);
      });
      if (!ops.length) {
        var c = ns('circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy);
        c.setAttribute('r', (r * 0.5).toFixed(2));
        c.setAttribute('class', 'c-vide'); g.appendChild(c);
      } else {
        ops.forEach(function (o, i) {
          var p = ns('path'), col = couleurOp(o), plein = o.etat === 'realise';
          p.setAttribute('d', secteur(cx, cy, r, i, ops.length));
          p.setAttribute('fill', plein ? col : 'none');
          p.setAttribute('stroke', col);
          p.setAttribute('stroke-width', 1.6);
          if (o.etat === 'cours') p.setAttribute('stroke-dasharray', '3.5 2.5');
          g.appendChild(p);
        });
      }
      gMark.appendChild(g);
    });
    var lab = gRoot.querySelector('.c-etiq');
    lab.style.fontSize = (10.5 / k) + 'px';
    lab.style.strokeWidth = (3 / k) + 'px';
    lab.style.display = (PW * k < 620) ? 'none' : '';
    appliquerCalques(k);
    majCompteurs(liste);
  }

  /* Le fond se densifie au zoom : illisible de trop loin, indispensable de près. */
  function palier(z, a, b) { return Math.max(0, Math.min(1, (z - a) / (b - a))); }
  function appliquerCalques(k) {
    var z = PW * k;
    if (gBati)   gBati.style.opacity   = calques.bati   ? (0.14 + 0.30 * palier(z, 900, 5000)) : 0;
    if (gVoirie) gVoirie.style.opacity = calques.voirie ? (0.25 + 0.70 * palier(z, 900, 4000)) : 0;
    if (!gRues) return;
    gRues.textContent = '';
    if (!calques.rues || z <= 7000 || !D.fond.voies) return;
    var r = svg.getBoundingClientRect(), m = 60;
    var laMax = unpy((-vue.y - m) / k), laMin = unpy((r.height - vue.y + m) / k);
    var loMin = unpx((-vue.x - m) / k), loMax = unpx((r.width - vue.x + m) / k);
    D.fond.voies.forEach(function (v) {
      if (v.lat < laMin || v.lat > laMax || v.lon < loMin || v.lon > loMax) return;
      var t = ns('text');
      t.setAttribute('transform', 'translate(' + px(v.lon).toFixed(1) + ',' +
                     py(v.lat).toFixed(1) + ') rotate(' + v.a + ')');
      t.setAttribute('font-size', (9 / k));
      t.setAttribute('stroke-width', (2.6 / k));
      t.textContent = v.n;
      gRues.appendChild(t);
    });
  }
  function unpx(x) { return B.lo0 + x / PW * (B.lo1 - B.lo0); }
  function unpy(y) { return B.la1 - y / PH * (B.la1 - B.la0); }

  function majCompteurs(liste) {
    var ops = 0, montant = 0;
    liste.forEach(function (e) {
      opsVisibles(e).forEach(function (o) { ops++; montant += o.montant || 0; });
    });
    var d = document.getElementById('carte-compteurs');
    if (d) d.innerHTML =
      '<span><b>' + liste.length + '</b> écoles</span>' +
      '<span><b>' + ops + '</b> opérations</span>' +
      '<span><b>' + (montant / 1e6).toFixed(2).replace('.', ',') + '</b> M€</span>';
  }

  /* Impression : on convertit le cadrage écran (panoramique + zoom) en un
     viewBox, et on neutralise la transformation. La carte s'imprime alors sur
     la portion de plan que vous regardez, à la résolution du papier, sans
     dépendre de la taille que le navigateur donne à la page imprimée. */
  var avantImpression = null;
  function preparerImpression() {
    if (!pret || avantImpression) return false;
    var r = svg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    avantImpression = { vb: svg.getAttribute('viewBox'),
                        tr: gRoot.getAttribute('transform'),
                        par: svg.getAttribute('preserveAspectRatio') };
    svg.setAttribute('viewBox', [(-vue.x / vue.k).toFixed(2),
                                 (-vue.y / vue.k).toFixed(2),
                                 (r.width / vue.k).toFixed(2),
                                 (r.height / vue.k).toFixed(2)].join(' '));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    gRoot.setAttribute('transform', '');
    return true;
  }
  function finImpression() {
    if (!avantImpression) return;
    svg.setAttribute('viewBox', avantImpression.vb);
    if (avantImpression.par) svg.setAttribute('preserveAspectRatio', avantImpression.par);
    else svg.removeAttribute('preserveAspectRatio');
    gRoot.setAttribute('transform', avantImpression.tr || '');
    avantImpression = null;
  }

  /* Une carte imprimée sans le rappel de ce qu'elle montre n'est pas
     exploitable : on décrit la vue en une ligne. */
  function resumeVue() {
    var LIB = { annee: 'Année', programme: 'Programme', type: 'Type',
                etat: 'État', secteur: 'Quartier', niveau: 'Niveau' };
    var parts = [];
    Object.keys(LIB).forEach(function (k) {
      if (filtre[k]) parts.push(LIB[k] + ' : ' + filtre[k]);
    });
    if (filtre.planches) {
      parts.push('Relevé planches : ' + (filtre.planches === 'aucun'
        ? 'écoles sans relevé' : filtre.planches));
    }
    if (filtre.q) parts.push('Recherche : « ' + filtre.q + ' »');
    var liste = ecolesVisibles(), ops = 0, montant = 0;
    liste.forEach(function (e) {
      opsVisibles(e).forEach(function (o) { ops++; montant += o.montant || 0; });
    });
    return {
      filtres: parts.length ? parts.join(' · ') : 'Aucun filtre — vue complète',
      chiffres: liste.length + ' écoles · ' + ops + ' opérations · ' +
                (montant / 1e6).toFixed(2).replace('.', ',') + ' M€',
      colorePar: colorerPar === 'etat' ? 'état' : 'type de travaux'
    };
  }

  function appliquer() {
    gRoot.setAttribute('transform',
      'translate(' + vue.x + ',' + vue.y + ') scale(' + vue.k + ')');
    marques();
    majOrtho();
  }
  function cadrer() {
    var r = svg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { requestAnimationFrame(cadrer); return; }
    svg.setAttribute('viewBox', '0 0 ' + r.width + ' ' + r.height);
    var k = Math.min(r.width / PW, r.height / PH) * 0.98;
    vue = { k: Math.max(k, 1e-3), x: (r.width - PW * k) / 2, y: (r.height - PH * k) / 2 };
    appliquer();
  }

  // --- interactions ----------------------------------------------------
  function brancherCarte() {
    var glisse = null, bulle = document.getElementById('carte-bulle');
    svg.addEventListener('pointerdown', function (ev) {
      glisse = { x: ev.clientX, y: ev.clientY, vx: vue.x, vy: vue.y, bouge: false };
      svg.setPointerCapture(ev.pointerId); svg.classList.add('glisse');
    });
    svg.addEventListener('pointermove', function (ev) {
      if (glisse) {
        var dx = ev.clientX - glisse.x, dy = ev.clientY - glisse.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) glisse.bouge = true;
        vue.x = glisse.vx + dx; vue.y = glisse.vy + dy; appliquer();
        return;
      }
      var g = ev.target.closest ? ev.target.closest('g.c-mk') : null;
      if (g) {
        var e = parId(g.dataset.id), r = svg.getBoundingClientRect();
        bulle.innerHTML = contenuBulle(e);
        bulle.classList.add('on');
        var demi = bulle.offsetWidth / 2;
        var x = Math.max(demi + 8, Math.min(ev.clientX - r.left, r.width - demi - 8));
        var y = ev.clientY - r.top;
        if (y - bulle.offsetHeight - 14 < 0) y += bulle.offsetHeight + 28;
        bulle.style.left = x + 'px'; bulle.style.top = y + 'px';
      } else bulle.classList.remove('on');
    });
    function fin(ev) {
      if (glisse) svg.releasePointerCapture(ev.pointerId);
      svg.classList.remove('glisse');
      var b = glisse && glisse.bouge; glisse = null; return b;
    }
    svg.addEventListener('pointerup', function (ev) {
      if (fin(ev)) return;
      // setPointerCapture, posé au pointerdown pour que le glissement survive
      // à une sortie de la carte, redirige aussi le relâchement vers le <svg> :
      // ev.target ne désigne alors plus le marqueur cliqué. On redemande donc
      // ce qui se trouve réellement sous le curseur. La bulle ne gêne pas, elle
      // est en pointer-events:none.
      var cible = document.elementFromPoint(ev.clientX, ev.clientY) || ev.target;
      var g = cible && cible.closest ? cible.closest('g.c-mk') : null;
      choisir(g ? g.dataset.id : null);
    });
    svg.addEventListener('pointercancel', fin);
    svg.addEventListener('pointerleave', function () { bulle.classList.remove('on'); });
    svg.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var r = svg.getBoundingClientRect();
      zoomer(Math.pow(0.999, ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
  }
  function zoomer(f, cx, cy) {
    var k2 = Math.max(0.4, Math.min(60, vue.k * f)); f = k2 / vue.k;
    vue.x = cx - (cx - vue.x) * f; vue.y = cy - (cy - vue.y) * f; vue.k = k2;
    appliquer();
  }
  function parId(id) {
    return D.ecoles.filter(function (e) { return e.id === id; })[0];
  }
  function choisir(id) {
    // On relit les observations à chaque ouverture de fiche : elles sont
    // écrites à plusieurs, et une note ajoutée par un collègue doit apparaître
    // sans recharger la page.
    if (id) { delete obsCache[id]; delete obsErreur[id]; }
    selection = id; marques(); panneau();
    if (id) {
      var e = parId(id), r = svg.getBoundingClientRect();
      var sx = px(e.lon) * vue.k + vue.x, sy = py(e.lat) * vue.k + vue.y;
      if (sx < 40 || sx > r.width - 40 || sy < 40 || sy > r.height - 40) {
        vue.x = r.width / 2 - px(e.lon) * vue.k;
        vue.y = r.height / 2 - py(e.lat) * vue.k;
        appliquer();
      }
    }
  }

  // --- rendu texte -----------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function euros(n) {
    return (n || 0).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
  }
  function ligneOp(o) {
    var col = couleurOp(o), plein = o.etat === 'realise';
    return '<li><span class="c-pt" style="' +
      (plein ? 'background:' + col : 'box-shadow:inset 0 0 0 1.6px ' + col) + '"></span>' +
      '<span class="c-nom">' + esc(o.type) + '</span>' +
      '<span class="c-an">' + o.annee + '</span>' +
      '<span class="c-mt">' + (o.montant ? euros(o.montant) : '—') + '</span>' +
      '<span class="c-et" style="color:' + col + '">' +
        esc((ETATS[o.etat] || {}).nom || o.etat) + '</span></li>';
  }
  function lignesPlanches(e) {
    if (!e.planches) return '';
    return Object.keys(e.planches).map(function (kk) {
      var f = e.planches[kk];
      return '<li><span class="c-pt" style="' +
        (f.s === 'realise' ? 'background:' + couleurPlanche(kk)
                           : 'box-shadow:inset 0 0 0 1.6px ' + couleurPlanche(kk)) + '"></span>' +
        '<span class="c-nom">' + PLANCHES[kk].nom + '</span>' +
        '<span class="c-an">' + esc(f.a) + '</span><span class="c-mt"></span>' +
        '<span class="c-et">' + (f.s === 'realise' ? 'relevé' : 'prévu') + '</span></li>';
    }).join('');
  }
  function contenuBulle(e) {
    var ops = opsVisibles(e);
    var h = '<b>' + esc(e.nom) + '</b><span class="c-q">' + esc(e.q || '') + '</span>';
    var pl = lignesPlanches(e);
    if (!ops.length) {
      return h + (pl ? '<ul class="c-ops">' + pl + '</ul>' +
                       '<div class="c-tot">relevé des planches</div>'
                     : '<div class="c-rien">Aucune opération programmée</div>');
    }
    var tot = ops.reduce(function (s, o) { return s + (o.montant || 0); }, 0);
    return h + '<ul class="c-ops">' + ops.map(ligneOp).join('') + pl + '</ul>' +
      '<div class="c-tot">' + ops.length + ' opération' + (ops.length > 1 ? 's' : '') +
      ' · ' + euros(tot) + (pl ? ' · relevé planches' : '') + '</div>';
  }
  /* ----------------------------------------------------------------
     Saisie. Les commandes n'apparaissent que si la source accepte
     l'écriture ET que le compte connecté a le rôle qu'il faut.
     ---------------------------------------------------------------- */
  var TYPES_CONNUS = [];
  function formOperation(op) {
    // Liste de référence réunie aux types déjà employés : sans elle, un type
    // jamais saisi — Pergola, Aménagement paysager — restait hors d'atteinte.
    var types = Source.typesTravaux ? Source.typesTravaux(D.ops)
              : (TYPES_CONNUS.length ? TYPES_CONNUS : ['Brasseur d\'air']);
    var progs = {};
    D.ops.forEach(function (o) { if (o.programme) progs[o.programme] = 1; });
    var lp = Object.keys(progs);
    return '<form class="op-form" onsubmit="Carte.enregistrer(this); return false;">' +
      '<input type="hidden" name="id" value="' + (op && op.id ? op.id : '') + '">' +
      '<div class="op-l"><label>Type de travaux</label><select name="type">' +
        types.map(function (t) {
          return '<option' + (op && op.type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="op-l"><label>Programme</label><select name="programme">' +
        lp.map(function (t) {
          return '<option' + (op && op.programme === t ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="op-2">' +
        '<div class="op-l"><label>Année</label><input name="annee" type="number" min="2024" ' +
          'max="2040" value="' + (op ? op.annee : new Date().getFullYear() + 1) + '"></div>' +
        // step="1000" refusait tout montant qui n'était pas un multiple de mille
        // — un devis à 41 200 € était rejeté par le navigateur, sans que la
        // cause soit lisible. Un budget prend la valeur qu'il a.
        '<div class="op-l"><label>Montant (€)</label><input name="montant" type="number" ' +
          'min="0" step="any" value="' + (op ? (op.montant || 0) : 0) + '"></div>' +
      '</div>' +
      '<div class="op-l"><label>Avancement</label><select name="etat">' +
        Object.keys(ETATS).map(function (k) {
          return '<option value="' + k + '"' + (op && op.etat === k ? ' selected' : '') +
                 '>' + ETATS[k].nom + '</option>'; }).join('') + '</select></div>' +
      '<div class="op-l"><label>Notes</label><textarea name="notes" rows="2">' +
        esc(op && op.notes || '') + '</textarea></div>' +
      '<div class="op-b"><button class="btn-ok" type="submit">Enregistrer</button>' +
        '<button class="btn-gris" type="button" onclick="Carte.annulerSaisie()">Annuler</button>' +
        (op && op.id ? '<button class="btn-danger" type="button" ' +
          'onclick="Carte.supprimer(' + op.id + ')">Supprimer</button>' : '') +
      '</div></form>';
  }

  var saisie = null;      // { id } ou { nouvelle: true }
  async function enregistrer(form) {
    if (window.event && window.event.preventDefault) window.event.preventDefault();
    var e = parId(selection);
    var corps = {
      ecole_id: e.id, ecole_libelle: e.court || e.nom,
      secteur: e.q, programme: form.programme.value,
      annee: parseInt(form.annee.value) || null, type: form.type.value,
      montant: parseFloat(form.montant.value) || 0,
      etat: form.etat.value, notes: form.notes.value.trim()
    };
    if (form.id.value) corps.id = parseInt(form.id.value);
    var bouton = form.querySelector('.btn-ok');
    bouton.disabled = true; bouton.textContent = 'Enregistrement…';
    try {
      await Source.enregistrerOperation(corps);
      saisie = null;
      await recharger();
    } catch (err) {
      bouton.disabled = false; bouton.textContent = 'Enregistrer';
      avertir(err.message);
    }
    return false;
  }
  async function supprimer(id) {
    if (!confirm('Supprimer cette opération ?')) return;
    try { await Source.supprimerOperation(id); saisie = null; await recharger(); }
    catch (err) { avertir(err.message); }
  }
  async function recharger() {
    await chargerAlertes();
    // Le tableau de bord tient sa propre copie des opérations : sans ce signal,
    // il garderait ses totaux jusqu'à la synchronisation suivante et afficherait
    // autre chose que la carte pendant cinq minutes.
    if (window.signalerEcriture) window.signalerEcriture();
    D.ops = await Source.travaux();
    var app = apparier(D.ops, D.ecoles);
    D.orphelines = vraimentOrphelines(D.ops, app); D.approx = app.approx;
    D.parEcole = {};
    D.ops.forEach(function (o) {
      var id = o.ecole_id || app.table[o.ecole];
      if (id) (D.parEcole[id] = D.parEcole[id] || []).push(o);
    });
    montantMax = 1;
    Object.keys(D.parEcole).forEach(function (id) {
      var t = D.parEcole[id].reduce(function (s2, o) { return s2 + (o.montant || 0); }, 0);
      if (t > montantMax) montantMax = t;
    });
    remplirFiltres(); marques(); panneau();
  }
  function avertir(m) {
    var d = document.getElementById('carte-etat');
    if (d) d.innerHTML = '⚠ ' + esc(m);
  }

  /* Observations : notes de terrain partagées, portées par la base. Tout membre
     peut en ajouter ; chacun supprime les siennes, un rédacteur celles des autres. */
  var obsCache = {}, obsErreur = {}, obsEnCours = null;
  var alertes = [], alerteSaisie = null, lienAlerteDispo = null;

  /* Les alertes sont chargées une fois avec le reste, puis relues après chaque
     écriture. Elles sont peu nombreuses : inutile d'interroger la base école
     par école. */
  async function chargerAlertes() {
    try { alertes = await Source.alertes(); } catch (e) { alertes = []; }
    // La sonde ne sert qu'à décider d'afficher « + alerte » : inutile de la
    // lancer pour un lecteur, qui n'écrira jamais. Elle coûte un aller-retour
    // et, tant que la migration n'est pas passée, un 400 dans la console.
    if (Source.alertesRattachables && Source.peutEcrire()) {
      try { lienAlerteDispo = await Source.alertesRattachables(); }
      catch (e) { lienAlerteDispo = false; }
    }
  }
  function alertesDe(operationId) {
    return alertes.filter(function (a) { return a.operation_id === operationId; });
  }
  function pastilleAlerte(a) {
    var n = NIVEAUX[a.niveau] || NIVEAUX.info;
    return '<li class="c-al" title="' + esc(n.nom + ' — ' + (a.desc || a.titre)) + '">' +
      '<span class="c-al-ic" style="color:' + n.c + '">' + n.ic + '</span>' +
      '<span class="c-al-t">' + esc(a.titre) + '</span>' +
      (Source.peutEcrire()
        ? '<button class="c-al-x" title="Retirer cette alerte" ' +
          'onclick="Carte.supprimerAlerte(' + a.id + ')">×</button>' : '') +
      '</li>';
  }
  function formAlerte(op) {
    var n = Object.keys(NIVEAUX);
    return '<form class="op-form al-form" onsubmit="Carte.enregistrerAlerte(this); return false;">' +
      '<input type="hidden" name="operation_id" value="' + op.id + '">' +
      '<div class="op-l"><label>Degré d’attention</label><select name="niveau">' +
        n.map(function (k) {
          return '<option value="' + k + '">' + NIVEAUX[k].ic + ' ' + NIVEAUX[k].nom +
                 '</option>'; }).join('') +
      '</select></div>' +
      '<div class="op-l"><label>Intitulé</label>' +
        '<input name="titre" required maxlength="120" ' +
        'placeholder="Ex. : subvention non confirmée"></div>' +
      '<div class="op-l"><label>Précision</label><textarea name="descr" rows="2" ' +
        'placeholder="Ce qu’il faut savoir, et ce qu’on attend."></textarea></div>' +
      '<div class="op-l"><label>Suivi</label><select name="statut">' +
        '<option value="ouvert">Ouvert</option>' +
        '<option value="en-cours">En cours</option>' +
        '<option value="resolu">Résolu</option></select></div>' +
      '<div class="op-b"><button class="btn-ok" type="submit">Signaler</button>' +
        '<button class="btn-gris" type="button" onclick="Carte.annulerAlerte()">Annuler</button>' +
      '</div></form>';
  }
  function listeAlertes(o) {
    if (Source.mode !== 'supabase') return '';
    var liste = alertesDe(o.id);
    return liste.length
      ? '<ul class="c-als">' + liste.map(pastilleAlerte).join('') + '</ul>' : '';
  }
  /* « modifier » et « + alerte » sur une même ligne : deux actions empilées à
     droite en gris pâle passaient inaperçues. */
  function actionsOp(o) {
    if (!Source.peutEcrire() || !o.id) return '';
    var b = ['<button onclick="Carte.editer(' + o.id + ')">modifier</button>'];
    // Colonne absente : pas de bouton, et une explication unique par fiche —
    // voir noteMigrationAlertes().
    if (Source.mode === 'supabase' && lienAlerteDispo !== false &&
        alerteSaisie !== o.id) {
      b.push('<button class="b-al" onclick="Carte.nouvelleAlerte(' + o.id +
             ')">+ alerte</button>');
    }
    return '<li class="op-modif">' + b.join('<span class="op-sep">·</span>') + '</li>';
  }
  function noteMigrationAlertes() {
    if (Source.mode !== 'supabase' || lienAlerteDispo !== false) return '';
    if (!Source.peutEcrire()) return '';
    return '<div class="c-note c-note-ko">Pour rattacher une alerte à une ' +
      'opération, exécutez <code>supabase/migration_alertes.sql</code> dans ' +
      'l’éditeur SQL de Supabase, puis rechargez cette page.</div>';
  }
  function blocObservations(e) {
    if (!Source.configure || Source.mode !== 'supabase') return '';
    // Les observations restent réservées aux membres. Sans session, la base
    // n'en renvoie aucune : afficher « aucune observation » serait un mensonge.
    var s2 = Source.session();
    if (!s2 || !s2.role) return '';
    var liste = obsCache[e.id];
    var connecte = !!(Source.session() && Source.session().role);
    var h = '<div class="c-bloc"><div class="c-bloc-t">Observations' +
            (liste && liste.length ? ' <span class="c-filtre">' + liste.length + '</span>' : '') +
            '</div>';
    if (obsErreur[e.id]) {
      // Dire l'échec plutôt qu'afficher « aucune » : une lecture qui n'a pas
      // abouti n'est pas une absence d'observation.
      return h + '<div class="c-rien c-rien-ko">Lecture impossible — ' +
             esc(obsErreur[e.id]) + '</div></div>';
    }
    if (liste === undefined) return h + '<div class="c-rien">Chargement…</div></div>';
    h += liste.length ? liste.map(function (o) {
      return '<div class="obs"><p>' + esc(o.texte) + '</p><div class="obs-qui">' +
        esc(o.auteur || 'anonyme') + ' · ' + esc(String(o.cree_le || '').slice(0, 10)) +
        (Source.peutSupprimerObservation(o)
           ? ' <button onclick="Carte.supprimerObs(' + o.id + ')">supprimer</button>' : '') +
        '</div></div>';
    }).join('') : '<div class="c-rien">Aucune observation.</div>';
    if (connecte) {
      h += obsEnCours === e.id
        ? '<form class="op-form" onsubmit="Carte.ajouterObs(this); return false;">' +
          '<div class="op-l"><label>Observation</label><textarea name="texte" rows="3" ' +
          'required placeholder="Constat de terrain, demande de l’école, suite à donner…">' +
          '</textarea></div>' +
          '<div class="op-l"><label>Votre nom ou service</label>' +
          '<input name="auteur" value="' + esc(auteurParDefaut()) + '"></div>' +
          '<div class="op-b"><button class="btn-ok" type="submit">Ajouter</button>' +
          '<button class="btn-gris" type="button" onclick="Carte.annulerObs()">Annuler</button>' +
          '</div></form>'
        : '<button class="btn-ajout" onclick="Carte.nouvelleObs()">+ Observation</button>';
    }
    return h + '</div>';
  }
  function auteurParDefaut() {
    var s2 = Source.session();
    return (s2 && s2.email) ? s2.email.split('@')[0].replace(/[._]/g, ' ') : '';
  }
  async function chargerObservations(id) {
    if (obsCache[id] !== undefined || obsErreur[id]) return;
    try { obsCache[id] = await Source.observations(id); delete obsErreur[id]; }
    catch (e) { obsErreur[id] = e.message; }
    if (selection === id) panneau();
  }

  // Sur une tablette, le pointeur ne survole pas : l'aperçu au vol n'existe pas.
  var tactile = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  function panneau() {
    var d = document.getElementById('carte-panneau');
    // « vide » sert à la mise en page tablette : sans fiche ouverte, le panneau
    // ne doit pas prendre un tiers de la largeur au détriment de la carte.
    d.classList.toggle('vide', !selection);
    if (!selection) {
      d.innerHTML = '<div class="c-vide-panneau">' + (tactile
        ? 'Touchez un point pour ouvrir la fiche de l’école.'
        : 'Survolez un point pour un aperçu, cliquez pour ouvrir la fiche de l’école.') +
        '</div>';
      return;
    }
    var e = parId(selection);
    var toutes = D.parEcole[e.id] || [];
    var ops = opsVisibles(e);
    var tot = toutes.reduce(function (s, o) { return s + (o.montant || 0); }, 0);
    var planches = e.planches || {};
    var LIB = { pergolas: 'Pergolas', vegetalisation: 'Végétalisation' };
    if (Source.mode === 'supabase') chargerObservations(e.id);
    d.innerHTML =
      '<div class="c-fiche">' +
      '<button class="c-retour" onclick="Carte.deselectionner()">← Toutes les écoles</button>' +
      '<h3>' + esc(e.nom) + '</h3>' +
      '<div class="c-meta">' + esc(e.niveau) + ' · ' + esc(e.q || '') +
        (e.verif ? ' · <span title="position issue du géocodage">position à confirmer</span>' : '') +
        '</div>' +
      '<div class="c-bloc"><div class="c-bloc-t">Opérations PPI' +
        (ops.length !== toutes.length ? ' <span class="c-filtre">' + ops.length +
          ' sur ' + toutes.length + ' (filtres actifs)</span>' : '') + '</div>' +
        (toutes.length ? '<ul class="c-ops">' + toutes.map(function (o) {
            return ligneOp(o) + (o.id ? listeAlertes(o) : '') + actionsOp(o) +
              (o.id && alerteSaisie === o.id ? formAlerte(o) : '');
          }).join('') + '</ul>' +
          '<div class="c-tot">Total ' + euros(tot) + '</div>' + noteMigrationAlertes()
          : '<div class="c-rien">Aucune opération programmée.</div>') +
        '<div id="op-saisie">' +
          (saisie ? formOperation(saisie.id
              ? toutes.filter(function (o) { return o.id === saisie.id; })[0] : null) : '') +
        '</div>' +
        (Source.peutEcrire() && !saisie
          ? '<button class="btn-ajout" onclick="Carte.nouvelle()">+ Opération</button>' : '') +
        '</div>' +
      (Object.keys(planches).length ?
        '<div class="c-bloc"><div class="c-bloc-t">Relevé des planches 2026</div>' +
        '<ul class="c-ops">' + lignesPlanches(e) + '</ul>' +
        '<div class="c-note">Pergolas et végétalisation ne figurent pas au PPI : ' +
        'relevé conservé depuis les planches ArcMap.</div></div>' : '') +
      blocObservations(e) +
      '</div>';
  }

  // --- filtres ---------------------------------------------------------
  function remplirFiltres() {
    var uniq = function (f) {
      var o = {}; D.ops.forEach(function (x) { if (f(x)) o[f(x)] = 1; });
      return Object.keys(o).sort();
    };
    var opts = function (id, vals, libelle) {
      var s = document.getElementById(id);
      s.innerHTML = '<option value="">' + libelle + '</option>' +
        vals.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    };
    opts('carte-f-annee', uniq(function (o) { return String(o.annee); }), 'Toutes les années');
    opts('carte-f-programme', uniq(function (o) { return o.programme; }), 'Tous les programmes');
    opts('carte-f-type', uniq(function (o) { return o.type; }), 'Tous les types');
    var q = {}; D.ecoles.forEach(function (e) { if (e.q) q[e.q] = 1; });
    opts('carte-f-secteur', Object.keys(q).sort(), 'Tous les quartiers');
    var s = document.getElementById('carte-f-etat');
    s.innerHTML = '<option value="">Tous les états</option>' +
      Object.keys(ETATS).map(function (k) {
        return '<option value="' + k + '">' + ETATS[k].nom + '</option>'; }).join('');
  }
  function legende() {
    var d = document.getElementById('carte-legende');
    var clair = theme === 'clair';
    var items = colorerPar === 'etat'
      ? Object.keys(ETATS).map(function (k) {
          return { n: ETATS[k].nom, c: clair ? ETATS[k].cc : ETATS[k].c }; })
      : Object.keys(couleursType).map(function (t) {
          return { n: t, c: (clair ? couleursTypeC : couleursType)[t] }; });
    var h = items.map(function (i) {
      return '<span class="c-lg"><i style="background:' + i.c + '"></i>' + esc(i.n) + '</span>';
    }).join('');
    if (calques.planches) {
      h += '<span class="c-lg-sep"></span>' + Object.keys(PLANCHES).map(function (kk) {
        return '<span class="c-lg"><i class="anneau" style="border-color:' +
          couleurPlanche(kk) + '"></i>' + PLANCHES[kk].nom + '</span>';
      }).join('') + '<span class="c-lg-note">relevé des planches, en couronne</span>';
    }
    // Mention de la source, exigée par l'IGN pour l'usage de ses images.
    if (theme === 'photo') {
      h += '<span class="c-lg-sep"></span>' +
           '<span class="c-lg-note">vue aérienne : orthophotographie ' +
           '© IGN — Géoplateforme</span>';
    }
    d.innerHTML = h;
  }

  // --- démarrage -------------------------------------------------------
  async function demarrer() {
    if (pret) { cadrer(); return; }
    var etat = document.getElementById('carte-etat');
    try {
      etat.textContent = 'Chargement du fond de plan…';
      var res = await Promise.all([
        Source.fond(), Source.ecoles(), Source.etiquettesQuartiers(), Source.travaux()
      ]);
      D.fond = res[0]; D.ecoles = res[1]; D.etiq = res[2]; D.ops = res[3];

      var types = {};
      D.ops.forEach(function (o) { types[o.type] = 1; });
      TYPES_CONNUS = Object.keys(types).sort();
      Object.keys(types).sort().forEach(function (t, i) {
        couleursType[t]  = TEINTES[i % TEINTES.length];
        couleursTypeC[t] = TEINTES_C[i % TEINTES_C.length];
      });

      await chargerAlertes();
      var app = apparier(D.ops, D.ecoles);
      D.orphelines = vraimentOrphelines(D.ops, app);
      D.approx = app.approx;
      D.parEcole = {};
      D.ops.forEach(function (o) {
        var id = o.ecole_id || app.table[o.ecole];   // Supabase porte déjà le lien
        if (!id) return;
        (D.parEcole[id] = D.parEcole[id] || []).push(o);
      });
      montantMax = 1;
      Object.keys(D.parEcole).forEach(function (id) {
        var t = D.parEcole[id].reduce(function (s, o) { return s + (o.montant || 0); }, 0);
        if (t > montantMax) montantMax = t;
      });

      // emprise
      var la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
      D.fond.quartiers.forEach(function (r) {
        r.p.forEach(function (p) {
          if (p[0] < la0) la0 = p[0]; if (p[0] > la1) la1 = p[0];
          if (p[1] < lo0) lo0 = p[1]; if (p[1] > lo1) lo1 = p[1];
        });
      });
      B = { la0: la0, la1: la1, lo0: lo0, lo1: lo1,
            k: Math.cos((la0 + la1) / 2 * Math.PI / 180) };
      PW = 1000; PH = PW * (la1 - la0) / ((lo1 - lo0) * B.k);

      svg = document.getElementById('carte-svg');
      fondDePlan(); brancherCarte(); remplirFiltres(); appliquerTheme(); cadrer();
      pret = true;
      var avis = [];
      if (D.approx.length) {
        avis.push(D.approx.map(function (x) {
          return '« ' + esc(x.nom) +' » (' + x.niveau.toLowerCase() +
                 ') rattachée à ' + esc(x.carte);
        }).join(' ; ') + ' — cette école ne figure pas au référentiel avec ce niveau.');
      }
      if (D.orphelines.length) {
        var perdues = D.ops.filter(function (o) {
          return D.orphelines.some(function (x) { return x.nom === o.ecole; });
        });
        avis.push(perdues.length + ' opération' + (perdues.length > 1 ? 's' : '') +
          ' non située' + (perdues.length > 1 ? 's' : '') + ' : ' +
          D.orphelines.map(function (x) { return esc(x.nom); }).join(', ') + '.');
        console.warn('Écoles PPI non rattachées :', D.orphelines);
      }
      etat.innerHTML = avis.length ? '⚠ ' + avis.join(' ') : '';
    } catch (e) {
      etat.textContent = 'Erreur : ' + e.message;
    }
  }

  function appliquerTheme() {
    var z = document.querySelector('#page-carte .carte-zone');
    if (z) {
      z.classList.toggle('clair', theme === 'clair');
      z.classList.toggle('photo', theme === 'photo');
    }
    var b = document.getElementById('carte-bulle');
    if (b) b.classList.toggle('clair', theme !== 'sombre');
    majOrtho(true);
    legende(); marques(); panneau();
  }

  /* Exporte ce que la carte montre, filtres compris. */
  function exporter() {
    var lignes = [['ecole', 'niveau', 'quartier', 'latitude', 'longitude',
                   'programme', 'type', 'annee', 'montant', 'etat']];
    ecolesVisibles().forEach(function (e) {
      var ops = opsVisibles(e);
      if (!ops.length) {
        lignes.push([e.nom, e.niveau, e.q, e.lat, e.lon, '', '', '', '', '']);
        return;
      }
      ops.forEach(function (o) {
        lignes.push([e.nom, e.niveau, e.q, e.lat, e.lon, o.programme, o.type,
                     o.annee, o.montant, (ETATS[o.etat] || {}).nom || o.etat]);
      });
    });
    var csv = '\ufeff' + lignes.map(function (r) {
      return r.map(function (v) {
        v = v == null ? '' : String(v);
        return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(';');
    }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'carte-operations-ppi.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ------------------------------------------------------------------
     Contrôle de cohérence : ce que le rapprochement entre la feuille PPI et
     le référentiel cartographique laisse en suspens. Recalculé à chaque
     affichage, donc toujours à jour de la feuille.
     ------------------------------------------------------------------ */
  function carte(n, libelle, alerte) {
    return '<div class="ctl-carte' + (alerte ? ' alerte' : '') + '"><b>' + n +
           '</b><span>' + libelle + '</span></div>';
  }
  function tableau(entetes, lignes) {
    if (!lignes.length) return '<div class="ctl-rien">Aucun.</div>';
    return '<div style="overflow-x:auto"><table class="ctl-table"><thead><tr>' +
      entetes.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + lignes.map(function (l) {
        return '<tr>' + l.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function origineDonnees() {
    if (Source.mode === 'supabase') return 'la table <code>operations</code> de la base';
    if (Source.mode === 'instantane') return 'l’instantané local des travaux';
    return 'l’onglet <code>Travaux</code> de la feuille Google';
  }

  async function rendreControle() {
    var d = document.getElementById('page-controle-corps');
    if (!pret) { await demarrer(); }
    if (!pret) { d.innerHTML = '<div class="ctl-rien">Données indisponibles.</div>'; return; }

    var nomsPPI = {}; D.ops.forEach(function (o) { nomsPPI[o.ecole] = 1; });
    var sansOp = D.ecoles.filter(function (e) { return !(D.parEcole[e.id] || []).length; });
    var aVerifier = D.ecoles.filter(function (e) { return e.verif; });
    var recalees  = D.ecoles.filter(function (e) { return e.pos === 'registre'; });
    var perdues = D.ops.filter(function (o) {
      return D.orphelines.some(function (x) { return x.nom === o.ecole; });
    });
    var planches = { pergolas: 0, vegetalisation: 0 };
    D.ecoles.forEach(function (e) {
      Object.keys(e.planches || {}).forEach(function (k) { planches[k]++; });
    });

    d.innerHTML =
      '<p class="ctl-intro">Rapprochement entre ' + origineDonnees() + ' et le référentiel ' +
      'cartographique des ' + D.ecoles.length + ' écoles de la commune. ' +
      'Recalculé à chaque affichage.</p>' +

      '<div class="ctl-cartes">' +
        carte(Object.keys(nomsPPI).length, 'écoles nommées au PPI') +
        carte(Object.keys(D.parEcole).length, 'rattachées à un point de la carte') +
        carte(perdues.length, 'opérations non situées', perdues.length > 0) +
        carte(sansOp.length, 'écoles sans aucune opération au PPI') +
      '</div>' +

      '<h3 class="ctl-t">Écoles du PPI non rattachées</h3>' +
      tableau(['Nom saisi', 'Meilleure approche', 'Score'],
        D.orphelines.map(function (x) {
          return [esc(x.nom), esc(x.meilleur || '—'), x.score]; })) +

      '<h3 class="ctl-t">Rapprochements approximatifs</h3>' +
      tableau(['Nom saisi', 'Niveau annoncé', 'Rattachée à'],
        D.approx.map(function (x) {
          return [esc(x.nom), esc(x.niveau), esc(x.carte)]; })) +
      (D.approx.length ? '<p class="ctl-note">Même nom, niveau différent : l’opération est ' +
        'posée au bon endroit, mais cette école ne figure pas au référentiel avec ce ' +
        'niveau. À vérifier dans votre inventaire.</p>' : '') +

      '<h3 class="ctl-t">Écoles sans opération au PPI <span class="ctl-n">' +
        sansOp.length + '</span></h3>' +
      tableau(['École', 'Niveau', 'Quartier', 'Relevé des planches'],
        sansOp.map(function (e) {
          var pl = Object.keys(e.planches || {}).map(function (k) {
            return PLANCHES[k].nom; }).join(', ');
          return [esc(e.nom), esc(e.niveau), esc(e.q), pl || '—']; })) +

      '<h3 class="ctl-t">Positions</h3>' +
      '<div class="ctl-cartes">' +
        carte(recalees.length, 'recalées sur le registre national des écoles') +
        carte(aVerifier.length, 'à confirmer : adresse imprécise ou secteur discordant',
              aVerifier.length > 0) +
      '</div>' +
      tableau(['École', 'Quartier', 'Origine de la position'],
        aVerifier.map(function (e) {
          return [esc(e.nom), esc(e.q), 'géocodage de l’adresse']; })) +

      '<h3 class="ctl-t">Relevé des planches, hors PPI</h3>' +
      '<p class="ctl-note">Le PPI ne suit ni les pergolas ni la végétalisation. Ces ' +
      'chiffres viennent des planches ArcMap de 2026 et ne sont pas mis à jour par la ' +
      'feuille.</p>' +
      '<div class="ctl-cartes">' +
        carte(planches.pergolas, 'écoles équipées de pergolas') +
        carte(planches.vegetalisation, 'écoles végétalisées') +
      '</div>';
  }

  // --- interface publique ---------------------------------------------
  return {
    demarrer: demarrer,
    controle: rendreControle,
    theme: function (v) { theme = v; appliquerTheme(); },
    editer: function (id) { saisie = { id: id }; panneau(); },
    nouvelleObs: function () { obsEnCours = selection; panneau(); },
    // Appelée par l'onglet Alertes après une modification ou une suppression :
    // la carte tient sa propre copie, qui serait sinon en retard.
    rafraichirAlertes: function () {
      return chargerAlertes().then(function () { if (pret) panneau(); });
    },
    nouvelleAlerte: function (opId) { alerteSaisie = opId; panneau(); },
    annulerAlerte: function () { alerteSaisie = null; panneau(); },
    enregistrerAlerte: function (form) {
      var opId = parseInt(form.operation_id.value);
      var op = (D.parEcole[selection] || []).filter(function (o) {
        return o.id === opId; })[0] || {};
      var e = parId(selection);
      var b = form.querySelector('.btn-ok');
      b.disabled = true; b.textContent = 'Envoi…';
      // L'année et l'école viennent de l'opération : les ressaisir serait une
      // occasion d'écart entre les deux vues.
      Source.enregistrerAlerte({
        niveau: form.niveau.value,
        titre: form.titre.value.trim(),
        descr: form.descr.value.trim(),
        statut: form.statut.value,
        annee: op.annee ? String(op.annee) : '',
        ecole: op.ecole || (e && (e.court || e.nom)) || '',
        operation_id: opId
      }).then(function () {
        alerteSaisie = null;
        if (window.signalerEcriture) window.signalerEcriture();
        return chargerAlertes();
      }).then(function () { panneau(); })
        .catch(function (err) {
          b.disabled = false; b.textContent = 'Signaler'; avertir(err.message);
        });
      return false;
    },
    supprimerAlerte: function (id) {
      if (!confirm('Retirer cette alerte ?')) return;
      Source.supprimerAlerte(id)
        .then(function () {
          if (window.signalerEcriture) window.signalerEcriture();
          return chargerAlertes();
        })
        .then(function () { panneau(); })
        .catch(function (err) { avertir(err.message); });
    },
    annulerObs: function () { obsEnCours = null; panneau(); },
    ajouterObs: function (form) {
      var texte = form.texte.value.trim();
      if (!texte) return false;
      var b = form.querySelector('.btn-ok');
      b.disabled = true; b.textContent = 'Ajout…';
      Source.ajouterObservation(selection, texte, form.auteur.value.trim())
        .then(function () {
          obsEnCours = null; delete obsCache[selection]; chargerObservations(selection);
        })
        .catch(function (err) {
          b.disabled = false; b.textContent = 'Ajouter'; avertir(err.message);
        });
      return false;
    },
    supprimerObs: function (id) {
      Source.supprimerObservation(id)
        .then(function () { delete obsCache[selection]; chargerObservations(selection); })
        .catch(function (err) { avertir(err.message); });
    },
    nouvelle: function () { saisie = { nouvelle: true }; panneau(); },
    annulerSaisie: function () { saisie = null; panneau(); },
    enregistrer: enregistrer,
    supprimer: supprimer,
    rafraichirDroits: function () { if (pret) { marques(); panneau(); } },
    calque: function (nom, actif) { calques[nom] = actif; legende(); marques(); },
    exporter: exporter,
    redimensionner: function () { if (pret) cadrer(); },
    preparerImpression: preparerImpression,
    finImpression: finImpression,
    resumeVue: resumeVue,
    deselectionner: function () { choisir(null); },
    // Appelée depuis l'onglet Alertes. Rend faux tant que la carte n'est pas
    // prête, pour que l'appelant réessaie plutôt que de perdre la demande.
    ouvrirEcole: function (id) {
      if (!pret || !parId(id)) return false;
      choisir(id);
      var g = document.querySelector('g.c-mk[data-id="' + id + '"]');
      if (g) g.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
    filtrer: function (champ, valeur) {
      filtre[champ] = valeur; selection = null; marques(); panneau();
    },
    chercher: function (v) { filtre.q = v; marques(); },
    colorer: function (mode) { colorerPar = mode; legende(); marques(); panneau(); },
    zoom: function (f) {
      var r = svg.getBoundingClientRect(); zoomer(f, r.width / 2, r.height / 2);
    },
    vueGenerale: function () { cadrer(); },
    diagnostic: function () { return { orphelines: D.orphelines, approx: D.approx,
                                       operations: D.ops.length,
                                       ecoles: D.ecoles.length, rattachees: Object.keys(D.parEcole).length }; }
  };
})();
