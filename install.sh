#!/usr/bin/env bash
# One-step install: dependencies, build, an `arcode` command on your PATH, then API-key setup.
#   git clone https://github.com/Manas-Ganti/arcode.git && cd arcode && ./install.sh
# Options: --no-setup (skip the key prompt; run `arcode setup` later). Safe to re-run (e.g. after git pull).
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

run_setup=1
for arg in "$@"; do
  case "$arg" in
    --no-setup) run_setup=0 ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

# arcode needs Node 20.12+ (process.loadEnvFile).
command -v node >/dev/null || die "Node.js 20.12+ is required: https://nodejs.org (or: nvm install 22)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
  || die "Node $(node --version) is too old; arcode needs 20.12+ (nvm install 22)"
command -v npm >/dev/null || die "npm not found (it ships with Node.js)"

say "Installing dependencies"
npm install --no-audit --no-fund --loglevel=error

say "Building"
npm run --silent build
chmod +x dist/cli.js

say "Adding the arcode command"
if npm link --no-audit --no-fund --loglevel=error >/dev/null 2>&1; then
  bin="$(npm prefix -g)/bin"
else
  # Global npm dir not writable (system Node without sudo): link into ~/.local/bin instead.
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  ln -sf "$PWD/dist/cli.js" "$bin/arcode"
fi
case ":$PATH:" in
  *":$bin:"*) say "arcode installed ($bin/arcode)" ;;
  *) say "arcode installed at $bin/arcode, but $bin is not on your PATH. Add this to your shell profile:"
     echo "    export PATH=\"$bin:\$PATH\"" ;;
esac

env_file="${ARCODE_HOME:-$HOME/.arcode}/.env"
if [ "$run_setup" = 1 ] && [ -f "$env_file" ] && grep -qE '^(export )?(VT)?ARC_API_KEY=.' "$env_file"; then
  say "API key already configured (re-run arcode setup to change it):"
  node dist/cli.js setup --show
elif [ "$run_setup" = 1 ] && [ -t 0 ] && [ -t 1 ]; then
  say "API key setup"
  node dist/cli.js setup
elif [ "$run_setup" = 1 ]; then
  say "Not a terminal, skipping key setup. Run: arcode setup  (or: echo \"\$KEY\" | arcode setup --provider <id>)"
fi
say "Done. Run arcode in any project folder; re-run arcode setup to change provider or key."
