/* =====================================================================
   Source de données — point de passage unique
   ---------------------------------------------------------------------
   Tout accès aux données passe par ici. Trois adossements possibles :

     'instantane'  le fichier local donnees/travaux-instantane.json.
                   Reproductible, hors ligne, sans dépendre du réseau.
     'gsheet'      lecture directe de la feuille Google, comme aujourd'hui.
     'supabase'    lecture ET écriture, avec authentification par lien magique
                   et rôles (lecteur / rédacteur / admin). Actif dès que
                   donnees/config.js porte l'adresse et la clé publique.

   Le reste de l'application ne sait pas d'où viennent les données.
   ===================================================================== */
window.Source = (function () {
  'use strict';

  var SHEET_ID = '1oY6JadaIwVrM85UBv9hJZra3iHl3bUyC8FEO2WjNX7c';
  var ONGLET_TRAVAUX = 'Travaux';
  var ONGLET_ALERTES = 'Alertes';

  // Choix de la source : ?source=... dans l'adresse. Par défaut Supabase s'il est
  // configuré, sinon la feuille Google.
  var configure = !!(window.CONFIG && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_CLE_PUBLIQUE);
  var mode = new URLSearchParams(location.search).get('source')
             || (configure ? 'supabase' : 'gsheet');
  if (['instantane', 'gsheet', 'supabase'].indexOf(mode) < 0) mode = 'gsheet';
  if (mode === 'supabase' && !configure) mode = 'gsheet';

  /* Types de travaux reconnus par la Direction. Cette liste fait référence :
     jusqu'ici, les types proposés à la saisie étaient déduits des opérations
     déjà enregistrées — un type jamais employé ne pouvait donc jamais l'être,
     et Pergola comme Aménagement paysager restaient inaccessibles. */
  var TYPES_TRAVAUX = [
    'Aménagement paysager',
    'Autre',
    'Brasseur d\'air',        // apostrophe droite : c'est celle des données
    'Création de salle de classe',
    'Étanchéité / sur-toiture',
    'Isolation préau',
    'Menuiserie',
    'Pergola',
    'Ravalement',
    'Réfection des coursives',
    'Restauration',
    'Sanitaire',
    'Sol souple',
    'Sol synthétique'
  ];
  /* Réunit la liste de référence et ce que portent réellement les données :
     un type saisi autrefois sous une autre forme ne doit pas disparaître. */
  function typesTravaux(operations) {
    var vus = {};
    TYPES_TRAVAUX.forEach(function (t) { vus[t] = 1; });
    (operations || []).forEach(function (o) { if (o.type) vus[o.type] = 1; });
    return Object.keys(vus).sort(function (a, b) {
      return a.localeCompare(b, 'fr');
    });
  }

  var cache = {};
  var session = null;      // { token, email, role } une fois connecté

  // ------------------------------------------------------------ Supabase
  // Appels REST directs : pas de bibliothèque à charger, et la CSP d'un
  // hébergement statique n'a rien de plus à autoriser.
  function sbUrl(chemin) { return CONFIG.SUPABASE_URL.replace(/\/$/, '') + chemin; }
  function sbEntetes(json) {
    var h = { apikey: CONFIG.SUPABASE_CLE_PUBLIQUE,
              Authorization: 'Bearer ' + (session ? session.token
                                                  : CONFIG.SUPABASE_CLE_PUBLIQUE) };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  /* Un projet Supabase gratuit se met en veille après une semaine sans usage :
     l'appel échoue alors sans réponse, ou avec un 5xx de passerelle. Le dire en
     clair, avec le geste qui répare, vaut mieux qu'un « Failed to fetch ». */
  function panne(message) {
    var e = new Error(message);
    e.reseau = true;                    // pour ne pas confondre avec un refus
    return e;
  }
  async function appel(url, init) {
    var r;
    try {
      r = await fetch(url, init);
    } catch (e) {
      throw panne('Base de données injoignable. Trois causes possibles : le ' +
        'projet Supabase s’est mis en veille — rouvrez-le sur supabase.com, ' +
        'bouton « Restore », comptez une minute ; l’adresse inscrite dans ' +
        'donnees/config.js est fausse ; ce poste n’a pas accès à Internet.');
    }
    if (r.status === 540 || r.status === 502 || r.status === 503 || r.status === 504) {
      throw panne('Le projet Supabase est en veille. Ouvrez supabase.com, ' +
        'choisissez le projet et cliquez sur « Restore » : il redémarre en ' +
        'une minute environ, puis rechargez cette page.');
    }
    return r;
  }

  async function sbRest(chemin, options, secondeChance) {
    options = options || {};
    var r = await appel(sbUrl('/rest/v1' + chemin), {
      method: options.method || 'GET',
      headers: Object.assign(sbEntetes(!!options.corps), options.entetes || {}),
      body: options.corps ? JSON.stringify(options.corps) : undefined
    });
    // Jeton périmé en cours de session : on le renouvelle et on rejoue une fois.
    if (r.status === 401 && session && session.refresh && !secondeChance) {
      if (await rafraichir()) return sbRest(chemin, options, true);
    }
    if (!r.ok) {
      var t = await r.text();
      if (r.status === 401 || r.status === 403) {
        throw new Error('Accès refusé. Votre compte n’est peut-être pas encore ' +
                        'inscrit comme membre.');
      }
      throw new Error('Supabase ' + r.status + ' : ' + t.slice(0, 160));
    }
    return r.status === 204 ? null : r.json();
  }

  /* Connexion par lien magique : aucun mot de passe à gérer ni à stocker. */
  async function connecter(email) {
    // Le point d'entrée REST attend « redirect_to » en paramètre d'adresse.
    // « options.emailRedirectTo » n'existe que dans la bibliothèque JS : passé
    // dans le corps, il est ignoré, et le lien renvoie alors vers l'adresse de
    // site du projet — localhost:3000 par défaut, où rien ne tourne.
    var retour = location.origin + location.pathname;
    var r = await appel(sbUrl('/auth/v1/otp?redirect_to=' + encodeURIComponent(retour)), {
      method: 'POST',
      headers: { apikey: CONFIG.SUPABASE_CLE_PUBLIQUE, 'Content-Type': 'application/json' },
      // create_user: false — ce formulaire ne crée pas de compte. Les comptes
      // s'ouvrent depuis Supabase, ce qui évite qu'une adresse inconnue puisse
      // s'en fabriquer un.
      body: JSON.stringify({ email: email, create_user: false })
    });
    if (!r.ok) {
      var t = await r.text();
      if (/signups? not allowed|otp_disabled/i.test(t)) {
        throw new Error('Aucun compte n’existe pour cette adresse. Un ' +
          'administrateur doit d’abord le créer dans Supabase, ' +
          'Authentication > Users > Add user.');
      }
      if (r.status === 429) {
        throw new Error('Trop de demandes en peu de temps. Le service de ' +
          'courriel de Supabase est limité à quelques envois par heure : ' +
          'attendez un moment avant de réessayer.');
      }
      throw new Error('Envoi impossible : ' + t.slice(0, 160));
    }
    return true;
  }

  /* Le jeton d'accès expire au bout d'une heure. Sans le jeton de
     rafraîchissement, l'utilisateur serait déconnecté toutes les heures et
     devrait redemander un lien : on conserve les deux. */
  var CLE_SESSION = 'ppi:session';
  function memoriserSession() {
    try {
      localStorage.setItem(CLE_SESSION, JSON.stringify({
        token: session.token, refresh: session.refresh, expire: session.expire }));
    } catch (e) {}
  }
  function lireSessionStockee() {
    try {
      var brut = localStorage.getItem(CLE_SESSION);
      if (brut) return JSON.parse(brut);
      var ancien = localStorage.getItem('ppi:jeton');   // format précédent
      return ancien ? { token: ancien } : null;
    } catch (e) { return null; }
  }
  function oublierSession() {
    try {
      localStorage.removeItem(CLE_SESSION);
      localStorage.removeItem('ppi:jeton');
    } catch (e) {}
  }

  async function rafraichir() {
    if (!session || !session.refresh) return false;
    try {
      var r = await appel(sbUrl('/auth/v1/token?grant_type=refresh_token'), {
        method: 'POST',
        headers: { apikey: CONFIG.SUPABASE_CLE_PUBLIQUE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh })
      });
      if (!r.ok) return false;
      var d = await r.json();
      if (!d.access_token) return false;
      session.token = d.access_token;
      if (d.refresh_token) session.refresh = d.refresh_token;
      session.expire = Math.floor(Date.now() / 1000) + (d.expires_in || 3600);
      memoriserSession();
      return true;
    } catch (e) { return false; }
  }

  /* Reprise depuis une adresse collée à la main.

     Quand l'adresse du site n'est pas encore déclarée dans Supabase, le lien
     reçu par courriel renvoie vers l'adresse de repli du projet — souvent
     localhost:3000 — qui n'existe pas sur le poste du destinataire. La page
     échoue, mais **son adresse porte déjà les jetons** : les coller ici suffit
     à ouvrir la session, sans rien attendre d'un réglage. */
  async function adopterLien(texte) {
    var t = String(texte || '').trim();
    if (!t) throw new Error('Collez l’adresse complète de la page.');
    var frag = t.indexOf('#') >= 0 ? t.slice(t.indexOf('#') + 1) : t;
    var p = new URLSearchParams(frag);
    if (!p.get('access_token')) {
      if (/\/auth\/v1\/verify|[?&]token=/.test(t)) {
        throw new Error('Ceci est le lien du courriel, pas encore la page ' +
          'd’arrivée. Ouvrez d’abord ce lien : la page affichera une erreur, ' +
          'c’est normal. Copiez alors l’adresse de cette page d’erreur et ' +
          'collez-la ici.');
      }
      throw new Error('Cette adresse ne contient pas de jeton de connexion. ' +
        'Copiez l’adresse complète de la page sur laquelle le lien vous a mené.');
    }
    session = {
      token: p.get('access_token'),
      refresh: p.get('refresh_token'),
      expire: parseInt(p.get('expires_at')) ||
              Math.floor(Date.now() / 1000) + (parseInt(p.get('expires_in')) || 3600)
    };
    memoriserSession();
    var moi = await lireIdentite();
    if (!moi) {
      throw new Error('Le jeton n’est plus valable — un lien de connexion ' +
        'expire au bout d’une heure. Demandez-en un nouveau.');
    }
    return moi;
  }

  /* Au retour du lien magique, les jetons arrivent dans le fragment d'adresse. */
  async function reprendreSession() {
    var frag = new URLSearchParams(location.hash.replace(/^#/, ''));
    var s0;
    if (frag.get('access_token')) {
      s0 = { token: frag.get('access_token'), refresh: frag.get('refresh_token'),
             expire: parseInt(frag.get('expires_at')) ||
                     Math.floor(Date.now() / 1000) + (parseInt(frag.get('expires_in')) || 3600) };
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      s0 = lireSessionStockee();
    }
    if (!s0 || !s0.token) return null;
    session = s0;
    memoriserSession();

    // Jeton périmé ou sur le point de l'être : on le renouvelle avant d'appeler.
    if (session.expire && session.expire - 60 < Math.floor(Date.now() / 1000)) {
      if (!await rafraichir()) { session = null; oublierSession(); return null; }
    }
    return await lireIdentite();
  }

  async function lireIdentite(secondeChance) {
    try {
      var u = await appel(sbUrl('/auth/v1/user'), { headers: sbEntetes() });
      if (u.status === 401 && !secondeChance && await rafraichir()) {
        return lireIdentite(true);
      }
      if (!u.ok) throw new Error('session expirée');
      var info = await u.json();
      session.email = info.email;
      session.uid = info.id;
      var m = await sbRest('/membres?select=role&user_id=eq.' + info.id);
      session.role = (m && m[0] && m[0].role) || null;
      return session;
    } catch (e) {
      if (e.reseau) throw e;      // base endormie : la session reste valable
      session = null; oublierSession();
      return null;
    }
  }

  function deconnecter() {
    session = null;
    oublierSession();
    cache = {};
  }

  // ---------------------------------------------------------------- outils
  function urlFeuille(onglet) {
    var u = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
            '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(onglet);
    if (onglet === ONGLET_ALERTES) u += '&headers=1&range=A2:F50';
    return u;
  }
  function analyser(texte) {
    var m = texte.match(/setResponse\(([\s\S]*)\)/);
    return m ? JSON.parse(m[1]) : null;
  }
  async function json(chemin) {
    var r = await fetch(chemin);
    if (!r.ok) throw new Error(chemin + ' : ' + r.status);
    return r.json();
  }

  // Le protocole file:// envoie une origine « null » que Google refuse.
  // Mieux vaut le dire clairement que laisser une erreur réseau opaque.
  function verifierOrigine() {
    if (location.protocol === 'file:') {
      throw new Error(
        'Cette page est ouverte depuis le disque. Google refuse alors de livrer ' +
        'la feuille. Lancez « demarrer.command » et ouvrez http://localhost.');
    }
  }

  // ------------------------------------------------------------- opérations
  async function travaux() {
    if (cache.travaux) return cache.travaux;
    var lignes;
    if (mode === 'instantane') {
      // L'instantané n'est pas publié en ligne : il porte les 119 opérations et
      // leurs montants en clair, que les règles d'accès protègent par ailleurs.
      var d;
      try {
        d = await json('donnees/travaux-instantane.json');
      } catch (e) {
        throw new Error('L’instantané local n’est pas disponible ici. Il n’est ' +
          'pas publié en ligne, parce qu’il contiendrait le PPI en clair. ' +
          'Connectez-vous pour lire les données de la base.');
      }
      lignes = d.lignes.map(function (l) {
        return {
          ecole: String(l.ecole || '').trim(),
          secteur: String(l.secteur || '').trim(),
          programme: String(l.programme || '').trim(),
          annee: parseInt(l.annee) || 2025,
          type: String(l.type || '').trim(),
          montant: parseFloat(l.montant) || 0,
          etat: normaliserEtat(l.etat),
          notes: String(l.notes || '').trim()
        };
      });
    } else if (mode === 'supabase') {
      var rs = await sbRest('/operations?select=id,ecole_id,ecole_libelle,secteur,' +
                            'programme,annee,type,montant,etat,notes&order=ecole_libelle');
      lignes = rs.map(function (o) {
        return { id: o.id, ecole: o.ecole_libelle || '', ecole_id: o.ecole_id,
                 secteur: o.secteur || '', programme: o.programme || '',
                 annee: parseInt(o.annee) || 2025, type: o.type || '',
                 montant: parseFloat(o.montant) || 0,
                 etat: o.etat || 'planifie', notes: o.notes || '' };
      });
    } else {
      verifierOrigine();
      var r = await fetch(urlFeuille(ONGLET_TRAVAUX));
      if (!r.ok) throw new Error(
        'Onglet Travaux inaccessible. Vérifiez que la feuille est partagée en lecture.');
      var t = analyser(await r.text());
      if (!t) throw new Error('Réponse inattendue de Google Sheets.');
      lignes = (t.table.rows || [])
        .filter(function (x) { return x.c && x.c[0] && x.c[0].v; })
        .map(function (row) {
          var g = function (i) { return row.c[i] ? (row.c[i].v != null ? row.c[i].v : '') : ''; };
          return {
            ecole: String(g(0)).trim(), secteur: String(g(1)).trim(),
            programme: String(g(2)).trim(), annee: parseInt(g(3)) || 2025,
            type: String(g(4)).trim(), montant: parseFloat(g(5)) || 0,
            etat: normaliserEtat(g(6)), notes: String(g(7)).trim()
          };
        });
    }
    cache.travaux = lignes;
    return lignes;
  }

  function normaliserEtat(v) {
    var s = String(v || '').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (s.indexOf('non realise') >= 0 || s.indexOf('reporte') >= 0) return 'reporte';
    if (s.indexOf('cours') >= 0) return 'cours';
    if (s.indexOf('consult') >= 0) return 'consult';
    if (s.indexOf('urgent') >= 0) return 'urgent';
    if (s.indexOf('planif') >= 0) return 'planifie';
    if (s.indexOf('realise') >= 0 || s.indexOf('termine') >= 0) return 'realise';
    return 'planifie';
  }

  async function alertes() {
    if (cache.alertes) return cache.alertes;
    var out = [];
    if (mode === 'supabase') {
      var rs = await sbRest('/alertes?select=*&order=id');
      out = rs.map(function (a, i) {
        return { id: a.id || i + 1, niveau: a.niveau, annee: a.annee || '',
                 titre: a.titre || '', desc: a.descr || '', ecole: a.ecole || '',
                 statut: a.statut || 'ouvert',
                 // Nul tant que la migration n'est pas passée : l'alerte est
                 // alors simplement générale, rien ne casse.
                 operation_id: a.operation_id == null ? null : a.operation_id };
      });
    } else if (mode === 'gsheet') {
      verifierOrigine();
      var r = await fetch(urlFeuille(ONGLET_ALERTES));
      if (r.ok) {
        var t = analyser(await r.text());
        var NIV = ['urgence', 'vigilance', 'decision', 'info'];
        out = ((t && t.table.rows) || []).map(function (row, i) {
          var g = function (k) { return row.c && row.c[k] ? (row.c[k].v || '') : ''; };
          var n = String(g(0)).trim().toLowerCase()
                    .normalize('NFD').replace(/[̀-ͯ]/g, '');
          n = NIV.filter(function (x) { return n.indexOf(x.slice(0, 5)) >= 0; })[0];
          return { id: i + 1, niveau: n, annee: String(g(1)).trim(),
                   titre: String(g(2)).trim(), desc: String(g(3)).trim(),
                   ecole: String(g(4)).trim(), statut: String(g(5)).trim() || 'ouvert' };
        }).filter(function (a) { return a.niveau && a.titre.length > 1; });
      }
    }
    cache.alertes = out;
    return out;
  }

  // ------------------------------------------------- référentiel et fond
  async function ecoles() {
    if (cache.ecoles) return cache.ecoles;
    if (mode === 'supabase') {
      var r = await sbRest('/ecoles?select=*&order=nom');
      cache.ecoles = r.map(function (e) {
        return { id: e.id, nom: e.nom, court: e.court, niveau: e.niveau, q: e.quartier,
                 lat: e.lat, lon: e.lon, planches: e.planches || undefined,
                 verif: e.position_a_confirmer || undefined,
                 pos: e.position_source === 'registre' ? 'registre' : undefined };
      });
    } else {
      cache.ecoles = (await json('donnees/ecoles.json')).ecoles;
    }
    return cache.ecoles;
  }
  async function observations(ecoleId) {
    if (mode !== 'supabase') return [];
    return sbRest('/observations?select=*&ecole_id=eq.' +
                  encodeURIComponent(ecoleId) + '&order=cree_le.desc');
  }
  async function etiquettesQuartiers() {
    if (!cache.etiq) cache.etiq = (await json('donnees/ecoles.json')).quartiers_labels;
    return cache.etiq;
  }
  async function fond() {
    if (!cache.fond) cache.fond = await json('donnees/fond.json');
    return cache.fond;
  }

  // ------------------------------------------------------------- écriture
  // Aucune source ne sait écrire aujourd'hui : une page statique ne peut pas
  // modifier une feuille Google. L'interface est posée pour que la bascule
  // Supabase n'ait qu'à la remplir.
  function peutEcrire() {
    return mode === 'supabase' && session &&
           (session.role === 'redacteur' || session.role === 'admin');
  }
  function refusEcriture() {
    if (mode !== 'supabase') {
      return 'Les opérations se modifient dans la feuille Google tant que ' +
             'l’application lit celle-ci.';
    }
    if (!session) return 'Connectez-vous pour modifier une opération.';
    return 'Votre compte est en lecture seule.';
  }
  async function enregistrerOperation(op) {
    if (!peutEcrire()) throw new Error(refusEcriture());
    cache.travaux = null;
    if (op.id) {
      // « id » désigne la ligne à modifier, dans l'adresse — jamais dans le
      // corps : la colonne est « generated always as identity » et PostgreSQL
      // refuse qu'on la réécrive, fût-ce à sa propre valeur (erreur 428C9).
      var id = op.id, corps = {};
      Object.keys(op).forEach(function (k) { if (k !== 'id') corps[k] = op[k]; });
      return sbRest('/operations?id=eq.' + id, { method: 'PATCH', corps: corps,
        entetes: { Prefer: 'return=representation' } });
    }
    return sbRest('/operations', { method: 'POST', corps: op,
      entetes: { Prefer: 'return=representation' } });
  }
  async function supprimerOperation(id) {
    if (!peutEcrire()) throw new Error(refusEcriture());
    cache.travaux = null;
    return sbRest('/operations?id=eq.' + id, { method: 'DELETE' });
  }
  // Observations : ouvertes à tout membre, y compris un lecteur. Chacun retire
  // les siennes ; un rédacteur peut retirer celles des autres.
  function refusObservation() {
    if (mode !== 'supabase') return 'Les observations demandent la base de données.';
    return 'Connectez-vous pour écrire une observation.';
  }
  function peutSupprimerObservation(o) {
    if (mode !== 'supabase' || !session || !session.role) return false;
    return peutEcrire() || (!!session.uid && o.cree_par === session.uid);
  }
  // ------------------------------------------------------------- alertes
  // Le rattachement d'une alerte à une opération demande une colonne ajoutée
  // après coup (supabase/migration_alertes.sql). On regarde une fois si elle
  // est là, pour pouvoir le dire clairement plutôt que d'échouer sèchement.
  var colonneLien = null;
  async function alertesRattachables() {
    if (mode !== 'supabase') return false;
    if (colonneLien !== null) return colonneLien;
    try {
      await sbRest('/alertes?select=operation_id&limit=1');
      colonneLien = true;
    } catch (e) {
      if (e.reseau) throw e;
      colonneLien = false;
    }
    return colonneLien;
  }
  function refusAlerte() {
    if (mode !== 'supabase') return 'Les alertes se modifient dans la feuille Google.';
    if (!session) return 'Connectez-vous pour signaler une alerte.';
    return 'Votre compte est en lecture seule.';
  }
  async function enregistrerAlerte(a) {
    if (!peutEcrire()) throw new Error(refusAlerte());
    if (a.operation_id != null && !await alertesRattachables()) {
      throw new Error('La base n’a pas encore la colonne de rattachement. ' +
        'Exécutez supabase/migration_alertes.sql dans l’éditeur SQL de Supabase, ' +
        'puis rechargez cette page.');
    }
    cache.alertes = null;
    if (a.id) {
      // Même précaution que pour les opérations : « id » est une colonne
      // d'identité, elle ne va pas dans le corps de la requête.
      var id = a.id, corps = {};
      Object.keys(a).forEach(function (k) { if (k !== 'id') corps[k] = a[k]; });
      return sbRest('/alertes?id=eq.' + id, { method: 'PATCH', corps: corps,
        entetes: { Prefer: 'return=representation' } });
    }
    return sbRest('/alertes', { method: 'POST', corps: a,
      entetes: { Prefer: 'return=representation' } });
  }
  async function supprimerAlerte(id) {
    if (!peutEcrire()) throw new Error(refusAlerte());
    cache.alertes = null;
    return sbRest('/alertes?id=eq.' + id, { method: 'DELETE' });
  }

  async function supprimerObservation(id) {
    if (mode !== 'supabase' || !session) throw new Error(refusObservation());
    return sbRest('/observations?id=eq.' + id, { method: 'DELETE' });
  }
  async function ajouterObservation(ecoleId, texte, auteur) {
    if (mode !== 'supabase' || !session) throw new Error(refusObservation());
    // cree_par est rempli par la base (default auth.uid()) : la règle d'ajout
    // l'exige, et le client n'a pas à le fournir.
    return sbRest('/observations', { method: 'POST',
      corps: { ecole_id: ecoleId, texte: texte, auteur: auteur },
      entetes: { Prefer: 'return=representation' } });
  }

  return {
    mode: mode,
    configure: configure,
    session: function () { return session; },
    connecter: connecter,
    reprendreSession: reprendreSession,
    adopterLien: adopterLien,
    deconnecter: deconnecter,
    observations: observations,
    supprimerOperation: supprimerOperation,
    ajouterObservation: ajouterObservation,
    supprimerObservation: supprimerObservation,
    peutSupprimerObservation: peutSupprimerObservation,
    refusEcriture: refusEcriture,
    travaux: travaux,
    alertes: alertes,
    TYPES_TRAVAUX: TYPES_TRAVAUX,
    typesTravaux: typesTravaux,
    alertesRattachables: alertesRattachables,
    enregistrerAlerte: enregistrerAlerte,
    supprimerAlerte: supprimerAlerte,
    ecoles: ecoles,
    etiquettesQuartiers: etiquettesQuartiers,
    fond: fond,
    peutEcrire: peutEcrire,
    enregistrerOperation: enregistrerOperation,
    normaliserEtat: normaliserEtat
  };
})();
