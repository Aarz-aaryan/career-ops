#!/usr/bin/env bash
# _nc-creds.sh — load Nextcloud credentials. SOURCE this, do not execute it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/_nc-creds.sh"
#
# Secrets live in ~/.hermes/profiles/aarz/.env (chmod 600, outside any git repo).
# Never hardcode credentials in this repo -- it is public.
# Values already present in the environment always win.

_nc_env="${NC_ENV_FILE:-$HOME/.hermes/profiles/aarz/.env}"
if [ -f "$_nc_env" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in
      NC_USER|NC_PASS|NC_HOST|NC_PORT)
        eval "_cur=\${$_k:-}"
        [ -z "$_cur" ] && export "$_k=$_v"
        ;;
    esac
  done < <(grep -E '^NC_(USER|PASS|HOST|PORT)=' "$_nc_env" 2>/dev/null)
fi
unset _nc_env _k _v _cur

# API auth identity (Nextcloud account), distinct from the SSH login user.
export NC_API_USER="${NC_API_USER:-${NC_USER:-}}"
export NC_API_PASS="${NC_API_PASS:-${NC_PASS:-}}"
