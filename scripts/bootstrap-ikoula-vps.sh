#!/usr/bin/env bash
# Bootstrap idempotent pour VPS Debian/Ubuntu (ex. Ikoula) — stack safevideoupload.
# Usage : sudo bash scripts/bootstrap-ikoula-vps.sh
# Variables optionnelles : REPO_URL, BRANCH (défaut main), INSTALL_DIR (défaut /opt/safevideoupload)

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/safevideoupload}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://origin.cursor.com/git/pedro-crescencio/tmp-6a228cc1f8aa5e15.git}"

log() { echo "==> $*"; }

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Ce script doit être exécuté en root (sudo)." >&2
    exit 1
  fi
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker et le plugin compose déjà installés ($(docker --version))"
    return 0
  fi

  log "Installation de Docker Engine + compose plugin (Debian/Ubuntu)"
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local distro codename
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    distro="${ID:-ubuntu}"
    codename="${VERSION_CODENAME:-}"
    if [[ -z "$codename" && "$distro" == "debian" ]]; then
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-bookworm}")"
    fi
  else
    distro="ubuntu"
    codename="jammy"
  fi

  if [[ "$distro" != "ubuntu" && "$distro" != "debian" ]]; then
    echo "Distribution non supportée : $distro (Debian/Ubuntu attendu)." >&2
    exit 1
  fi

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${distro} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
  log "Docker installé : $(docker --version)"
}

ensure_repo() {
  log "Répertoire d'installation : ${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Dépôt existant — git fetch + checkout ${BRANCH}"
    git -C "${INSTALL_DIR}" fetch origin
    git -C "${INSTALL_DIR}" checkout "${BRANCH}" 2>/dev/null || git -C "${INSTALL_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}"
    git -C "${INSTALL_DIR}" pull --ff-only origin "${BRANCH}" || true
  else
    log "Clone ${REPO_URL} (branche ${BRANCH})"
    if [[ -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ]]; then
      echo "Répertoire non vide sans .git : ${INSTALL_DIR}" >&2
      exit 1
    fi
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

prepare_env_and_storage() {
  cd "${INSTALL_DIR}"

  if [[ ! -f .env ]]; then
    cp .env.example .env
    sed -i "s|^CAPTURE_TOKEN=.*|CAPTURE_TOKEN=$(openssl rand -hex 32)|" .env
    sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -hex 32)|" .env
    log "Fichier .env créé depuis .env.example (CAPTURE_TOKEN et ADMIN_TOKEN générés : à lire dans .env)"
    echo ""
    echo "┌─────────────────────────────────────────────────────────────────┐"
    echo "│  À FAIRE avant production : éditer ${INSTALL_DIR}/.env          │"
    echo "│  • DOMAIN=stream.votredomaine.fr                                │"
    echo "│  • ACME_EMAIL=ops@votredomaine.fr                               │"
    echo "│  • CAPTURE_TOKEN / ADMIN_TOKEN : déjà générés (voir .env)       │"
    echo "│  Puis : cd ${INSTALL_DIR} && docker compose up -d               │"
    echo "└─────────────────────────────────────────────────────────────────┘"
    echo ""
  else
    log ".env déjà présent — non modifié"
  fi

  mkdir -p storage/raw storage/blurred caddy/data caddy/config
}

compose_up() {
  cd "${INSTALL_DIR}"
  log "docker compose up --build -d"
  docker compose up --build -d
  docker compose ps
}

print_firewall_reminder() {
  cat <<'EOF'

── Pare-feu VPS (recommandé) ─────────────────────────────────────
Exposer uniquement :
  • TCP 80, 443  — Caddy (HTTPS viewer, capture, WHIP, HLS)
  • UDP 8189 ET TCP 8189 — ICE WebRTC (flux du téléphone ; TCP = repli)

Exemple ufw (à adapter, décommenter si ufw est installé) :

  # ufw default deny incoming
  # ufw default allow outgoing
  # ufw allow OpenSSH
  # ufw allow 80/tcp
  # ufw allow 443/tcp
  # ufw allow 8189/udp
  # ufw allow 8189/tcp
  # ufw enable

Ouvrir aussi 8189 (udp + tcp) dans le pare-feu du fournisseur (panneau Ikoula).
Ne pas publier RTSP (8554), RTMP (1935) ni l’API MediaMTX sur l’hôte public.

── Suite ─────────────────────────────────────────────────────────
DNS : enregistrement A pour DOMAIN → IP publique du VPS.
Capture : https://<DOMAIN>/capture/ (saisir CAPTURE_TOKEN dans le formulaire, jamais dans l'URL)
Diagnostic : ./scripts/diagnose-live.sh

EOF
}

main() {
  need_root
  install_docker_if_missing
  ensure_repo
  prepare_env_and_storage
  compose_up
  print_firewall_reminder
  log "Bootstrap terminé."
}

main "$@"
