# Capte – notes & tâches (FR / EN / DE)

Une webapp installable : vous dictez ou écrivez, Capte propose « tâche ou note » et « perso ou pro », vous validez.
Les données sont gardées sur l'appareil **et** dans une base de données Postgres (Supabase), synchronisée entre tous vos appareils.

Tous les fichiers sont à la racine, sans sous-dossier, et il n'y a aucune étape de build.

## 1. (Optionnel) Créer la base de données (Supabase, gratuit)
Sans base, Capte fonctionne entièrement sur l'appareil : laissez `config.js` vide et faites des sauvegardes régulières (un bandeau vous le rappelle après 7 jours).

1. Créez un compte sur https://supabase.com, puis **New project** (région : Zurich ou Francfort).
2. **SQL Editor → New query** : collez le contenu de `supabase.sql`, puis **Run**.
3. **Project Settings → API** : copiez la **Project URL** et la clé publique **anon**.
4. Collez-les dans `config.js` :
   ```js
   window.CAPTE_CONFIG = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: 'eyJ…' };
   ```
   La clé *anon* peut être publique : chaque utilisateur ne voit que ses données, grâce aux règles RLS de `supabase.sql`.

## 2. Mettre en ligne (GitHub + Netlify)
1. Créez un dépôt GitHub et déposez-y tous les fichiers, à la racine.
2. Sur Netlify : **Add new site → Import an existing project → GitHub**, puis choisissez le dépôt.
   - Build command : *(vide)*
   - Publish directory : *(vide, ou `.`)*
3. **Retirer le badge « Powered by Netlify »** (gratuit, même sur le plan Free) : Netlify → votre site → **Project configuration → General → Powered by Netlify badge** → désactiver.
4. *(Si vous utilisez Supabase)* Dans Supabase, **Authentication → URL Configuration → Site URL** : mettez l'adresse Netlify (ex. `https://capte-aldo.netlify.app`), pour que le lien de confirmation par e-mail renvoie vers l'app.

## 3. Première utilisation
- Ouvrez l'app, puis **⚙︎ Réglages → Créer un compte** (e-mail et mot de passe). Confirmez avec l'e-mail reçu, puis **Se connecter**.
- Sur iPhone : Safari → Partager → **Sur l'écran d'accueil**. Sur Android : menu Chrome → **Installer l'application**.
- Raccourcis : `…/index.html?rec=1` ouvre l'app directement en dictée, `…/index.html?view=tasks` ouvre les tâches.

## Sécurité des données
- **Trois copies** : sur l'appareil (fonctionne hors ligne), dans la base Postgres, et dans vos exports (CSV ou JSON).
- Une modification est d'abord enregistrée sur l'appareil, puis envoyée à la base dès qu'il y a du réseau.
- Une suppression est « douce » : la ligne est marquée `deleted = true` mais reste dans la base. L'app n'a pas le droit d'effacer définitivement une ligne.
- Plan gratuit de Supabase : le projet est mis en pause après 7 jours sans activité (les données sont conservées et le projet se réactive depuis le tableau de bord), et il n'y a pas de sauvegarde automatique. Utiliser l'app régulièrement suffit à éviter la pause. Pour des sauvegardes quotidiennes automatiques, passez au plan Pro, ou faites de temps en temps **Réglages → Tout télécharger**.

## Fichiers
| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | L'application |
| `i18n.js` | Traductions FR / EN / DE |
| `config.js` | Connexion à Supabase (à remplir) |
| `supabase.js` | Bibliothèque Supabase (v2.119.2), embarquée pour fonctionner sans CDN |
| `supabase.sql` | Schéma de la base et règles de sécurité |
| `manifest.json`, `sw.js`, `icon-*.png`, `apple-touch-icon.png` | Installation sur l'écran d'accueil et fonctionnement hors ligne |

## Import / export
- **Tâches** et **Notes** : boutons Télécharger et Importer, au format CSV (s'ouvre dans Excel) ou JSON.
- Un CSV importé peut avoir des colonnes en français, anglais ou allemand (`titre` / `title` / `titel`, `echeance` / `due` / `faellig`, etc.). Une seule colonne de titres suffit.
- Réimporter un fichier ne crée pas de doublons (les éléments sont reconnus par leur `id`).
