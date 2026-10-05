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
  éphémère, jeu de permissions propre, réponse du modèle renvoyée à l'appelant. Voir §8 pour les
  limites connues.
- **Logging et export de diagnostics** (electron-log, crash reporter, net log).
- **14 fichiers de tests unitaires** couvrant IPC, onboarding, store, updater et WSL.
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

Autres commandes utiles (dans `packages/desktop`) :

```bash
bun run typecheck                # vérifier les types
bun run build                    # compiler sans empaqueter
OPENCODE_CHANNEL=asse bun run build   # compiler pour le canal « asse »
bun run package:mac              # générer le .dmg
bun run package:win              # installer Windows
bun run package:linux            # AppImage / deb / rpm
```

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
  attend la fin du run et renvoie la réponse du modèle. Points à connaître :
  - **Liste d'autorisés, pas liste d'interdits.** Les rôles en lecture seule (`researcher`,
    `code_reviewer`, `brainstormer`, `critic`, `outliner`) reçoivent d'abord un refus global, puis
    uniquement les outils de leur `recommendedTools` qui n'écrivent pas. Un enfant `researcher` reçoit
    donc exactement `read`, `grep`, `glob`, `websearch`, `webfetch` — ni `write`, ni `edit`, ni `bash`,
    ni `computer`, ni `browser`, ni `mod`, ni `memory_*`, ni `schedule`, ni `mcp_store`.
  - **Les rôles qui écrivent gardent tout.** `code_builder` et consorts reçoivent les 24 outils du
    moteur, moins `subagent` : un sous-agent ne peut jamais en engendrer un autre.
  - **Réouverture refusée.** L'agent enfant est éphémère et disparaît à la fin du run. Une session
    enfant rouverte ensuite ne résout plus son agent et se voit refuser **tous** ses outils — choix
    volontaire, préféré à la réapplication des règles.
  - **Non câblé** : `steer` en cours de run, et le mode arrière-plan.
  - **Limite héritée** : sur les 24 outils reçus par un enfant qui écrit, **12 n'appellent aucune
    vérification de permission** (`browser`, `computer`, `mcp_store`, les quatre `memory_*`, `mod`,
    `observer`, `read_image`, `read_pdf`, `schedule`) — ils s'exécutent donc sans contrôle pour cet
    enfant.
- **Bash : les commandes en lecture seule ne demandent pas d'autorisation.**
  `packages/core/src/sandbox/bash-readonly.ts` laisse passer sans invite les commandes prouvées non
  mutantes (`ls`, `cat`, `pwd`, `git log`…), refuse dès qu'un opérateur shell apparaît (`;`, `|`,
  `>`, `$( )`) et compare le nom exact du programme (`lsof` n'est pas `ls`). Conséquence à connaître :
  `cat ~/.ssh/id_rsa` ne déclenche aucune demande. Un refus **global** sur `bash` reste efficace
  (l'outil n'est alors pas proposé du tout), mais un refus visant une ressource précise serait
  contourné : la vérification est sautée, pas résolue en « autorisé ».
- **Pas de mode hors-ligne** : le moteur a besoin du réseau pour appeler les modèles.

## 9. Idées d'amélioration

_(section à compléter)_

- [ ] Icônes et identité visuelle propres au canal `asse`
- [ ] Activer la signature et la notarisation macOS pour pouvoir distribuer
- [x] Brancher un vrai moteur d'exécution pour les sous-agents — fait : session enfant réelle, liste
      d'autorisés, réouverture refusée
- [ ] Ajouter une vérification de permission aux 12 outils qui n'en ont aucune (`computer`,
      `browser`, `mcp_store`, `memory_*`, `mod`, `observer`, `read_image`, `read_pdf`, `schedule`)
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
