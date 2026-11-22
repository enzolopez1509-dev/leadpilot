# LeadPilot — rappels automatiques par e-mail

Les rappels sont traités par la fonction Supabase `send-lead-reminders`, appelée toutes les 15 minutes par le job pg_cron `leadpilot-auto-reminders`.

## Configuration obligatoire du fournisseur e-mail

Le code utilise l'API transactionnelle Resend. Avant le premier envoi :

1. Créer un compte sur https://resend.com et ajouter un domaine expéditeur.
2. Vérifier le domaine dans Resend (DNS SPF/DKIM).
3. Créer une clé API Resend.
4. Dans Supabase Dashboard → Edge Functions → Secrets, ajouter :
   - `RESEND_API_KEY` : la clé API Resend (secret).
   - `LEADPILOT_FROM_EMAIL` : l'expéditeur vérifié, par exemple `LeadPilot <rappels@votredomaine.fr>`.
5. Ne jamais mettre ces valeurs dans le dépôt Git, dans le code du navigateur ou dans un message public.

## Préférences utilisateur

Chaque commercial doit activer les rappels e-mail dans LeadPilot. Le bouton enregistre son adresse, `preferred_channel=email` et son consentement dans `user_notification_settings`. Le destinataire est ensuite validé comme membre de l'agence et l'adresse e-mail configurée est utilisée (à défaut, l'adresse du compte Supabase).

## Fréquence et anti-doublon

Le job existant s'exécute toutes les 15 minutes. Une relance n'est envoyée qu'une fois pour la combinaison prospect, destinataire et date de relance. Une nouvelle date de relance autorise un nouvel e-mail.

## Test

Après configuration des deux secrets, activer les e-mails sur un compte commercial et créer une relance échue sur un prospect actif qui lui est attribué. Vérifier l'arrivée du message et les logs de la fonction Edge.
