# Zéro dépendance npm (Node natifs uniquement : http, node:sqlite, node:child_process) — un
# seul besoin externe : le binaire `git` pour lire l'historique du dépôt monté en lecture seule.
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY src ./src
COPY public ./public

EXPOSE 8080
CMD ["node", "src/server.js"]
