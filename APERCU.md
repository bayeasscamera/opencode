# Aperçu — OpenCode Asse (application desktop)

> Document de travail. Faits vérifiés dans le code au 05/10/2026.
> Aucun secret n'y figure. Les points non vérifiés sont marqués « à confirmer ».

---

## 1. But de l'app

OpenCode Asse est un agent de programmation IA sous forme d'application de bureau, construite à
partir du code open source [opencode](https://github.com/anomalyco/opencode). Elle permet d'écrire,
modifier et tester du code en dialoguant avec un modèle d'IA, dans une fenêtre locale sur son
ordinateur. C'est une édition personnalisée (« canal asse ») : elle partage le moteur de l'original
mais s'installe à côté, avec son propre nom et ses propres données.

Utilisateurs visés : développeurs qui veulent une application locale, pas un site web.

## 2. Technologies

| Élément | Valeur |
|---|---|
| Framework | **Electron 42.3.3** |
| Langages | TypeScript, SolidJS, HTML/CSS |
| Build | electron-vite 5, Vite 7 |
| Packaging | electron-builder 26.15.2 |
| Base de données locale | SQLite (drizzle-orm) |
| Terminal intégré | `@lydell/node-pty` 1.2.0-beta.12 |
| Mise à jour auto | electron-updater 6.8.9 |
| Rapports d'erreur | Sentry (optionnel) |
| Runtime | Bun (scripts), Node 24 dans Electron |
| Version app | 1.18.34 |

## 3. Structure du projet

```
OpenCodeAsse/                 Monorepo (30+ packages)
├── packages/
│   ├── desktop/      ← CETTE APPLICATION (Electron)
│   │   ├── src/main/      Processus principal Node (serveur, fenêtres, menus)
│   │   ├── src/preload/   Pont sécurisé main ↔ interface
│   │   ├── src/renderer/  Interface SolidJS + 60+ langues
│   │   ├── scripts/       Pré-build (icônes, CLI, serveur)
│   │   └── resources/     Icônes, métadonnées Linux/macOS
│   ├── app/          Interface web partagée (SolidJS) — réutilisée par desktop et web
│   ├── opencode/     Moteur : serveur HTTP + outils agent  ← embarqué dans desktop
│   ├── core/         Cœur du runtime (sessions, outils, mémoire)
│   ├── llm/          Couche modèles IA (fournisseurs, protocoles)
│   ├── protocol/     Contrat d'API (types partagés)
│   ├── server/       Implémentation des handlers HTTP
│   └── tui/          Version terminal
└── APERCU.md         Ce document
```

## 4. Fonctionnalités actuelles

- **Fenêtre principale** multi-onglets, avec restauration de position et taille.
- **Serveur local embarqué** démarré automatiquement au lancement, sur `127.0.0.1` avec un port
  libre et un mot de passe généré à chaque session.
- **First launch onboarding** : écran d'accueil au premier démarrage, avec création possible d'un
  projet par défaut dans le dossier Documents.
- **Terminal intégré** grâce à node-pty.
- **Interface en plus de 60 langues** (le français est inclus).
- **Multi-serveurs Windows / WSL** : détection des distributions, installation, démarrage et
  connexion à un serveur distant.
- **Mise à jour automatique** toutes les 10 minutes, avec dialogue de confirmation.
- **Deep links** : le protocole `opencode-asse://` ouvre l'app depuis le navigateur ou le système.
- **Zoom et pincer-zoom**, plein écran, titrebar adaptative selon le thème.
- **Sélecteurs de fichiers/dossiers**, presse-papiers images, ouverture de fichiers externes.
- **Brouillons persistants** : le texte non envoyé survit à un redémarrage.
- **Migration depuis l'ancienne version Tauri** de l'app.
- **Sous-agents réels** : l'outil `subagent` délègue une mission à une vraie session enfant — agent
  éphémère, jeu de permissions propre, réponse du modèle renvoyée à l'appelant. **Testé uniquement
  avec un faux modèle** : aucun run contre un vrai fournisseur n'a été exécuté. Voir §8 pour les
  limites connues.
- **Logging et export de diagnostics** (electron-log, crash reporter, net log).
- **15 fichiers de tests unitaires** couvrant IPC, onboarding, store, updater, WSL et la
  configuration d'empaquetage.
- **Canal « asse »** : nom, identifiant (`ai.opencode.desktop.asse`) et icônes dédiés, coexistants
  avec les canaux dev / beta / prod.

## 5. Fonctionnement interne

Trois processus communiquent entre eux :

```
┌─────────────────┐   IPC (canal sécurisé)   ┌──────────────────┐
│  Renderer       │ ←──────────────────────→ │  Main            │
│  (interface)    │                          │  (fenêtres,menu) │
└─────────────────┘                          └────────┬─────────┘
                                                       │ utilityProcess
                                                       │ (fork)
┌─────────────────┐   HTTP 127.0.0.1 + mot de passe ┌──▼──────────┐
│  Sidecar        │ ←───────────────────────────── │  Serveur    │
│  (moteur agent) │                                 │  opencode   │
└─────────────────┘                                 └─────────────┘
```

1. **Main** (`src/main/index.ts`) démarre tout : proxy, certificats système, instance unique,
   migrations, journalisation, puis lance le sidecar.
2. **Sidecar** (`src/main/sidecar.ts`) est un processus Node séparé qui charge le serveur opencode
   compilé et l'écoute sur une URL locale. L'isolation évite qu'un plantage du moteur tue l'interface.
3. **Preload** (`src/preload/index.ts`) expose une API unique `window.api` via `contextBridge`.
   Aucun accès direct à Node n'est possible depuis l'interface : tout passe par cette liste blanche.
4. **Renderer** (`src/renderer/index.tsx`) est une application SolidJS qui consomme le package
   `@opencode-ai/app` et se connecte au serveur via le client HTTP généré.

Côté modèles IA : l'utilisateur configure ses fournisseurs (Anthropic, OpenAI, etc.) dans l'app ; ces
clés ne transitent jamais par le code desktop, qui ne fait que relayer les appels vers le serveur.
La liste exacte des fournisseurs pris en charge est à confirmer depuis l'interface.

## 6. Configuration

**Variables d'environnement** (lues par le code desktop) :

| Variable | Rôle |
|---|---|
| `OPENCODE_CHANNEL` | Canal de build : `dev`, `beta`, `prod`, `asse` |
| `OPENCODE_PORT` | Force le port du serveur local (sinon port libre) |
| `OPENCODE_SIDECAR_V2` | `1` active le nouveau moteur V2 |
| `OPENCODE_TEST_ONBOARDING` | `1` force un environnement d'accueil isolé |
| `VITE_SENTRY_DSN` | Rapport d'erreur Sentry (optionnel) |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | Upload des sourcemaps |
| `HTTPS_PROXY` / `NO_PROXY` | Proxy réseau (le loopback est toujours exclu) |

**Fichiers de config** : les réglages persistants vivent dans `electron-store`, sous le dossier
`userData` de l'app — soit `~/Library/Application Support/ai.opencode.desktop.asse` sur macOS.
Les clés API des modèles sont saisies dans l'interface et ne sont pas écrites dans le dépôt.

## 7. Lancer l'app

Depuis la racine du monorepo :

```bash
bun install                      # installer les dépendances
bun run dev:desktop              # lancer en mode développement
```

Autres commandes utiles. **Les scripts d'empaquetage ne vivent que dans
`packages/desktop/package.json`** : la racine n'expose aucun script `package*`, donc
`bun run package:mac` lancé depuis la racine échoue. Il faut se placer dans le paquet, ou préfixer
par `bun --cwd packages/desktop`.

```bash
cd packages/desktop
bun run typecheck                     # vérifier les types
bun run build                         # compiler sans empaqueter (déclenche prebuild)
OPENCODE_CHANNEL=asse bun run build   # compiler pour le canal « asse »
bun run package                       # empaqueter pour l'OS courant
bun run package:mac                   # --mac   → .dmg
bun run package:win                   # --win   → installateur NSIS
bun run package:linux                 # --linux → AppImage, deb, rpm
```

Cibles vérifiées dans `electron-builder.config.ts` (les quatre canaux `dev`, `beta`, `prod` et
`asse` donnent exactement les mêmes) :

| Script | Drapeau | `target` déclaré | Artefacts |
|---|---|---|---|
| `package:mac` | `--mac` | `mac.target: ["dmg"]` | `.dmg` |
| `package:linux` | `--linux` | `linux.target: ["AppImage", "deb", "rpm"]` | AppImage, `.deb`, `.rpm` |
| `package:win` | `--win` | `win.target: ["nsis"]` | installateur NSIS |

Deux pièges à connaître :

- **`package:*` ne compile pas.** Il n'existe aucun hook `prepackage` : lancer `bun run package:mac`
  sans `bun run build` préalable empaquette un `out/` absent ou périmé. C'est `build` qui déclenche
  `prebuild` (icônes, CLI, moteur).
- **Pas de compilation croisée.** Chaque cible ne se construit que sur son propre OS, et `--mac` ne
  produit que l'architecture de la machine hôte. Il n'y a plus de cible `zip` à côté du `dmg`.

Le canal ne change ni les cibles ni la signature : il ne modifie que l'identifiant d'application, le
nom du produit, le protocole (`opencode` / `opencode-asse`) et la publication.

## 8. Problèmes connus

- **Signature macOS désactivée** (`hardenedRuntime`, `notarize`, signature DMG : tous à `false`).
  L'app n'est pas notarisée : macOS affichera un avertissement à l'installation. Volontaire pour un
  build local, bloquant pour une distribution publique.
- **Le sidecar V1 dépend de `../opencode/dist/node`** : le build desktop échoue si le moteur n'a pas
  été compilé au préalable (le script `prebuild` s'en charge).
- **`packages/app` épingle un client vendorisé** (`opencode-ai-client-1.17.13-v2.tgz`) au lieu du
  workspace. Risque de décalage entre l'interface et le moteur.
- **Timeout de démarrage** : 60 s pour lancer le sidecar, 30 s pour la vérification de santé. Sur une
  machine lente, l'app peut sembler bloquée.
- **Le canal `asse` n'a pas de jeu d'icônes propre** : il réutilise celui de `dev` (volontaire,
  documenté dans `copy-icons.ts`).
- **Aucun `TODO`/`FIXME` dans le code desktop** — l'hygiène de commentaires est bonne. En revanche,
  les modules `mod/` et `observer/` contournent l'architecture Effect avec des `Map` globaux et du
  JSON sur disque. Le sous-agent publie lui aussi son instance `SessionV2` par un accesseur global
  (`packages/core/src/subagent/runtime.ts`) : contournement assumé et documenté, à revisiter si le
  moteur devient multi-tenant. À traiter.
- **Sous-agent : comportement réel et limites** (vérifié le 05/10/2026). `subagent` exécute
  désormais un vrai run : il crée une session enfant (`parentID`), y déclare un agent éphémère
  `subagent-<rôle>-<taskId>` (25 étapes maximum), lui applique un jeu de règles, envoie le prompt,
  attend la fin du run et renvoie la réponse du modèle. **Tout cela n'a été testé qu'avec un faux
  modèle** : les tests couvrent bien le cycle complet (session enfant, agent éphémère, règles, attente
  de fin, extraction de la réponse) mais avec un modèle factice qui rejoue des tours scriptés. Aucun
  appel à un vrai fournisseur n'a été exécuté, donc la latence réelle, le coût, les erreurs de
  fournisseur et la qualité des réponses d'un vrai modèle ne sont pas vérifiés. Points à connaître :
  - **Liste d'autorisés, pas liste d'interdits.** Les rôles en lecture seule (`researcher`,
    `code_reviewer`, `brainstormer`, `critic`, `outliner`) reçoivent d'abord un refus global, puis
    uniquement les outils de leur `recommendedTools` qui n'écrivent pas. Un enfant `researcher` reçoit
    donc exactement `read`, `grep`, `glob`, `websearch`, `webfetch` — ni `write`, ni `edit`, ni `bash`,
    ni `computer`, ni `browser`, ni `mod`, ni `memory_*`, ni `schedule`, ni `mcp_store`.
  - **Les rôles qui écrivent gardent tout.** Le moteur expose **25** outils ; un enfant `code_builder`
    en reçoit **24** — tous, sauf `subagent`, qu'un sous-agent ne peut donc jamais engendrer. (Compté
    en matérialisant le registre avec `rulesFor("code_builder", …)` : 25 outils au total, 24 pour
    l'enfant, `subagent` seul retiré.)
  - **Réouverture refusée.** L'agent enfant est éphémère et disparaît à la fin du run. Une session
    enfant rouverte ensuite ne résout plus son agent et se voit refuser **tous** ses outils — choix
    volontaire, préféré à la réapplication des règles.
  - **Non câblé** : `steer` en cours de run, et le mode arrière-plan.
  - **Limite héritée, en grande partie corrigée.** Sur les 24 outils reçus par un enfant qui écrit,
    **12 n'appelaient aucune vérification de permission**. Huit en ont désormais une : `browser`,
    `computer`, `mcp_store`, `memory_record`, `mod`, `read_image`, `read_pdf` et `schedule`
    (`read_image` et `read_pdf` réclament en plus `external_directory` hors de la Location, comme
    `read`). Restent sans invite `memory_list`, `memory_recall` et `memory_reflect`, qui ne font que
    lire ce qui est déjà stocké, et **`observer`**, dont les actions `dismiss` et `reset` modifient
    pourtant un état persisté — c'est le dernier outil à traiter.
- **Bash : les commandes en lecture seule ne demandent pas d'autorisation — sauf si elles visent un
  secret.**
  `packages/core/src/sandbox/bash-readonly.ts` laisse passer sans invite les commandes prouvées non
  mutantes (`ls`, `cat`, `pwd`, `git log`…), refuse dès qu'un opérateur shell apparaît (`;`, `|`,
  `>`, `$( )`) et compare le nom exact du programme (`lsof` n'est pas `ls`). L'auto-approbation est en
  plus refusée dès qu'un argument touche un fichier sensible (`~/.ssh`, `.env*`, `*.pem`, `*.key`,
  `id_rsa*`, `~/.aws`, `~/.config/gcloud`, `~/.npmrc`, `auth.json`) ou sort de la Location : dans ce
  cas l'outil demande l'autorisation. Le jeu de règles est désormais **toujours évalué** — `assert`
  est appelé avec `prompt: false` au lieu d'être sauté — donc un `deny` visant une ressource précise
  bloque bien une commande en lecture seule.
- **Pas de mode hors-ligne** : le moteur a besoin du réseau pour appeler les modèles.

## 9. Idées d'amélioration

_(section à compléter)_

- [ ] Icônes et identité visuelle propres au canal `asse`
- [ ] Activer la signature et la notarisation macOS pour pouvoir distribuer
- [x] Brancher un vrai moteur d'exécution pour les sous-agents — fait : session enfant réelle, liste
      d'autorisés, réouverture refusée
- [ ] Valider le sous-agent contre un vrai modèle : les tests n'utilisent qu'un faux modèle
- [x] Ajouter une vérification de permission aux outils qui n'en avaient aucune — fait pour `browser`,
      `computer`, `mcp_store`, `memory_record`, `mod`, `read_image`, `read_pdf` et `schedule`
- [ ] Traiter le dernier outil sans vérification : `observer` (`dismiss` et `reset` écrivent un état
      persisté)
- [ ] Remplacer le client vendorisé par le package du workspace
- [ ] Migrer les modules `mod/` et `observer/` vers l'architecture Effect (Location-scoped) — le
      sous-agent l'est déjà, sauf son accesseur de publication
- [ ] À confirmer : tableau de bord de suivi des coûts par modèle

## 10. Fichiers les plus importants

| Fichier | Rôle |
|---|---|
| `packages/desktop/src/main/index.ts` | **Point d'entrée.** Orchestration complète : proxy, certificats, migrations, sidecar, fenêtres, menu, updater. |
| `packages/desktop/src/main/sidecar.ts` | Le moteur. Charge le serveur opencode et l'expose sur le port local avec authentification. |
| `packages/desktop/src/preload/index.ts` | La frontière de sécurité. Définit toute l'API `window.api` exposée à l'interface. |
| `packages/desktop/electron-builder.config.ts` | Packaging : identifiants, canaux, cibles par OS, signature. |
| `packages/desktop/src/renderer/index.tsx` | Assemblage de l'interface : connexion serveur, onboarding, langue, Sentry, raccourcis. |
