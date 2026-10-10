# Étiquettes DLC

Application de gestion des étiquettes de date limite de consommation pour une cuisine
professionnelle. Plusieurs tablettes partagent les mêmes données via un serveur.

## Structure

- `server.js` — serveur Express + API
- `db.js` — connexion PostgreSQL et création automatique des tables
- `public/index.html` — l'application (interface)
- `render.yaml` — configuration du déploiement Render

## Accès par défaut

- Administrateur : code `1234` (à changer dans Réglages dès le premier lancement)
- Employé de test : Sam, code `1111`

## Rôles

**Employé** — parcourt les catégories, ouvre un produit, ajuste le délai DLC,
change le frigo attribué, imprime l'étiquette. Rien d'autre.

**Administrateur** — écran Gestion : catégories, produits, frigos, utilisateurs,
historique. Plus les Réglages (code d'accès, installation en icône).

## Fonctionnement des alertes

Un produit dont la DLC est dépassée déclenche une alerte rouge visible sur tous
les écrans, y compris avant connexion. Tant que des alertes existent, un employé
connecté ne peut rien faire d'autre que les traiter. Après confirmation,
l'application propose de réimprimer une étiquette avec une date recalculée.

## Inventaire & food cost

Page `/foodcost.html` (bouton « Inventaire & food cost » sur l'accueil).
Code : `foodcost.js` (API `/api/fc/...`).

- **Étagères / zones** : créées par défaut (Étagère épices, Étagère garage,
  Boissons, Frigo tacos, Frigo shawarma, Congélateur, Chambre froide),
  modifiables par le gérant.
- **Gérant** (même code que l'administrateur) : saisit les articles, leur unité
  de comptage et leur prix d'achat en CHF ; ouvre et clôture les inventaires.
- **Employé** : choisit une étagère et saisit la quantité de chaque article
  (boutons +/−, décimales acceptées, enregistrement automatique). Il ne voit
  pas les prix.
- **Clôture** : fige les prix d'achat ; un changement de prix ultérieur ne
  modifie plus la valeur d'un inventaire passé.
- **Food cost** d'une période = stock début (inventaire clôturé précédent)
  + achats − stock fin, divisé par le chiffre d'affaires. Calculé sur les
  matières premières et les emballages ; un type peut être exclu (par défaut
  les produits de nettoyage, vaisselle & autres).
- **Types de marchandise** : Matières premières, Emballages, Produits
  nettoyage, vaisselle & autres (modifiables). Chaque article a un type ; la
  valeur du stock est totalisée par type (pas par zone, les zones servent
  seulement à organiser le comptage).
- **Quantités** : décimales acceptées (1,5 ou 3,2). Un article peut avoir une
  2e unité facultative pour la marchandise entamée, avec sa contenance
  (ex. 1 carton de poulet = 10 kg) : l'employé compte les cartons fermés et les
  kg déballés, le prix au kg est déduit du prix du carton.
- Export CSV (séparateur `;`, ouvre directement dans Excel), avec sous-totaux
  par type.

## Déploiement sur Render

1. Créer un dépôt Git avec ces fichiers et le pousser sur GitHub
2. Sur Render : New → Blueprint, sélectionner le dépôt
   (Render lit `render.yaml` et crée le service web + la base PostgreSQL)
3. Attendre la fin du déploiement, puis ouvrir l'adresse fournie

La base de données est initialisée automatiquement au premier démarrage.

## Développement local

```bash
npm install
export DATABASE_URL="postgresql://user:motdepasse@localhost:5432/etiquettes_dlc"
npm start
```

Puis ouvrir http://localhost:3000

## À venir

Impression directe vers l'imprimante Niimbot B1 via Web Bluetooth
(nécessite Chrome sur Android ou Windows).
