# Patches de dépendances

Ce dossier contient les 19 patches déclarés dans `patchedDependencies` du `package.json` racine et
appliqués par `bun install` (`bunfig.toml` : `exact = true`, `minimumReleaseAge` 3 jours).

## Pourquoi ce fichier existe

L'emplacement `patches/` ne dit pas **pourquoi** un patch existe. Ce fichier recense ce que chacun
modifie de façon **vérifiable** (compté depuis le diff), et signale explicitement ce qui reste à
documenter par son auteur — plutôt que d'inventer une justification.

## Inventaire

| Paquet                                       | Fichiers |   + |   − | Touche `dist/` |
| -------------------------------------------- | -------: | --: | --: | :------------: |
| `@ai-sdk/amazon-bedrock@4.0.166`             |        4 |  56 |   8 |      oui       |
| `@ai-sdk/anthropic@3.0.111`                  |        6 | 176 |  12 |      oui       |
| `@ai-sdk/google@3.0.73`                      |        5 |  17 |   0 |      oui       |
| `@ai-sdk/groq@3.0.31`                        |        5 |   5 |  19 |      oui       |
| `@ai-sdk/mistral@3.0.51`                     |        8 | 256 |  92 |      oui       |
| `@ai-sdk/openai-compatible@2.0.41`           |        3 |   3 |   3 |      oui       |
| `@ai-sdk/openai@3.0.88`                      |        6 |   0 | 186 |      oui       |
| `@ai-sdk/xai@3.0.139`                        |        9 |  67 |  39 |      oui       |
| `@dnd-kit/dom@0.5.0`                         |        2 |  22 |   0 |      non       |
| `@modelcontextprotocol/sdk@1.29.0`           |       12 | 250 |  93 |      oui       |
| `@npmcli/agent@4.0.2`                        |        1 |   1 |   1 |      non       |
| `@pierre/trees@1.0.0-beta.4`                 |        4 |  21 |   5 |      oui       |
| `@silvia-odwyer/photon-node@0.3.4`           |        1 |  45 |  43 |      non       |
| `@standard-community/standard-openapi@0.2.9` |        1 |   4 |   1 |      oui       |
| `@tanstack/virtual-core@3.17.3`              |        5 |  19 |  10 |      oui       |
| `effect@4.0.0-beta.83`                       |        2 |  19 |   2 |      oui       |
| `gcp-metadata@8.1.2`                         |        1 |   4 |   0 |      non       |
| `pacote@21.5.0`                              |        1 |   5 |   2 |      non       |
| `solid-js@1.9.10`                            |        6 |  40 |  16 |      oui       |

## Ce qui est établi (lu dans le diff)

- **`effect@4.0.0-beta.83`** — encapsule le champ `data` du transport SSE pour lui donner son propre
  identifiant OpenAPI (`<identifiant>Stream`) au lieu de revendiquer le nom du schéma décodé. La
  raison est écrite dans le patch lui-même.
- **`@modelcontextprotocol/sdk@1.29.0`** — ajoute des surcharges `callTool` et
  `transport.onsessionexpired` → `_initialize(transport)` (ré-initialisation à l'expiration de
  session), et extrait la requête `initialize` inline vers `_initialize`. Portage de correctifs amont
  sur la version épinglée.
- **`@ai-sdk/openai@3.0.88`** — supprime la gestion de `serviceTier` (flex/priority) et ses
  avertissements : 186 lignes retirées, aucun ajout.

## Fragilité : 14 patches sur 19 modifient du `dist/`, dont 6 **uniquement** du `dist/`

Les patches qui ne touchent que la sortie compilée (`@ai-sdk/amazon-bedrock`, `@ai-sdk/anthropic`,
`@modelcontextprotocol/sdk`, `@pierre/trees`, `@standard-community/standard-openapi`,
`solid-js`) sont les plus fragiles : ils s'appliquent au build publié, donc une montée de version ou
une reconstruction peut les perdre **silencieusement**, sans qu'aucun test ne le signale. Ce sont
aussi ceux à surveiller en priorité lors d'une mise à jour de dépendance.

## Non documenté

La raison des 15 autres patches (dont les 8 SDK de fournisseurs IA) n'est écrite nulle part : ni
commentaire en tête de fichier, ni référence à une issue amont. À compléter par leur auteur, en
précisant à chaque fois **pourquoi** et **quand le retirer**.

## `install-korean-ime-fix.sh` n'est pas un patch

Ce script n'est pas un patch `bun` : c'est un installateur communautaire (issue amont #14371, fork
tiers) qui clone un fork, applique un `sed` sur le composant TUI `prompt/index.tsx` et reconstruit le
binaire. Il est conservé tel quel ; si ce dossier doit ne contenir que des patches, il appartient
plutôt à `script/`.

## Modifier un patch

```sh
bun patch <paquet>      # crée un dossier de travail
# éditer, puis :
bun patch --commit <paquet>
```

Toute nouvelle entrée doit arriver avec sa justification dans ce fichier.
