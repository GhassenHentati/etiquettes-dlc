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
