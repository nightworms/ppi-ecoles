/* =====================================================================
   Connexion et rôles
   ---------------------------------------------------------------------
   Connexion par lien magique : aucun mot de passe à retenir ni à stocker.
   Le rôle est lu dans la table « membres » ; sans ligne, aucun accès.
   Sans Supabase configuré, ce bandeau reste discret et l'application
   fonctionne en lecture, comme avant.
   ===================================================================== */
window.Compte = (function () {
  'use strict';

  var ROLES = {
    admin:     'administrateur',
    redacteur: 'rédacteur',
    lecteur:   'lecteur'
  };
  var boite;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function rendre(message) {
    if (!boite) return;
    var s = Source.session();
    if (!Source.configure) {
      boite.innerHTML = '<span class="cpt-info" title="Les opérations se modifient ' +
        'dans la feuille Google">lecture seule</span>';
      return;
    }
    if (s && s.role) {
      boite.innerHTML =
        '<span class="cpt-qui"><b>' + esc(s.email) + '</b>' +
        '<span class="cpt-role cpt-' + s.role + '">' + (ROLES[s.role] || s.role) + '</span></span>' +
        '<button class="cpt-btn" onclick="Compte.sortir()">Se déconnecter</button>';
      return;
    }
    if (s && !s.role) {
      boite.innerHTML =
        '<span class="cpt-alerte">Compte non inscrit — demandez à un administrateur ' +
        'de vous ajouter</span>' +
        '<button class="cpt-btn" onclick="Compte.sortir()">Se déconnecter</button>';
      return;
    }
    boite.innerHTML =
      (message ? '<span class="cpt-info">' + esc(message) + '</span>' : '') +
      '<form class="cpt-form" onsubmit="return Compte.entrer(this)">' +
      '<input type="email" name="email" required placeholder="prenom.nom@saintdenis.re" ' +
      'autocomplete="email">' +
      '<button class="cpt-btn cpt-primaire" type="submit">Se connecter</button></form>';
  }

  async function init() {
    var entete = document.querySelector('header');
    if (!entete) return;
    boite = document.createElement('div');
    boite.className = 'cpt';
    entete.parentNode.insertBefore(boite, entete.nextSibling);
    rendre();
    if (!Source.configure) return;
    try {
      await Source.reprendreSession();
    } catch (e) {
      // Base injoignable : inutile de redemander une connexion, la session est
      // sans doute bonne. On dit ce qui se passe et on s'arrête là.
      if (e.reseau) {
        boite.innerHTML = '<span class="cpt-alerte">' + esc(e.message) + '</span>';
        return;
      }
    }
    rendre();
    majDroits();
  }

  /* Les commandes d'écriture n'apparaissent que pour qui peut écrire. */
  function majDroits() {
    document.body.classList.toggle('peut-ecrire', Source.peutEcrire());
    if (window.Carte && Carte.rafraichirDroits) Carte.rafraichirDroits();
  }

  async function entrer(form) {
    var email = form.email.value.trim();
    if (!email) return false;
    boite.innerHTML = '<span class="cpt-info">Envoi en cours…</span>';
    try {
      await Source.connecter(email);
      boite.innerHTML = '<span class="cpt-info">Lien envoyé à <b>' + esc(email) +
        '</b>. Ouvrez-le depuis ce poste.</span>';
    } catch (e) {
      rendre('Envoi impossible : ' + e.message);
    }
    return false;
  }

  function sortir() {
    Source.deconnecter();
    rendre();
    majDroits();
    location.reload();
  }

  return { init: init, entrer: entrer, sortir: sortir, majDroits: majDroits };
})();
