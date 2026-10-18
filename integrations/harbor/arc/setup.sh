#!/bin/bash
# One-time setup for generating trajectories on VT ARC with Apptainer (no Docker on ARC).
# Run on an OWL login node, from the arcode repo root:
#   bash integrations/harbor/arc/setup.sh
# Re-run after `git pull` to rebuild the arcode runtime from the new code.
#
# Builds, under $ARCODE_RT (default ~/arcode-rt, ~250 MB):
#   node/     Node 22 (official linux-x64 build), bind-mounted read-only into every task container
#   prefix/   arcode installed from this checkout (npm pack), likewise
#   extra/uv  uv, which SWE-rebench's Dockerfile adds on top of the image (Apptainer skips the Dockerfile)
#   shim/     a `singularity` wrapper (finds apptainer; optional on-disk overlay, see below)
# and installs Harbor (pinned) with uv, the same way as on the Mac.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
RT=${ARCODE_RT:-$HOME/arcode-rt}
NODE_VERSION=${NODE_VERSION:-22.12.0}
HARBOR_VERSION=0.24.0
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }

say "uv + harbor $HARBOR_VERSION"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
if ! harbor --version 2>/dev/null | grep -qx "$HARBOR_VERSION"; then
  uv tool install --force "harbor==$HARBOR_VERSION"
fi
echo "harbor $(harbor --version), python $("$(uv tool dir)/harbor/bin/python" -V)"

say "node $NODE_VERSION -> $RT/node"
if [ "$("$RT/node/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  rm -rf "$RT/node" && mkdir -p "$RT/node"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$RT/node" --strip-components=1
fi
export PATH="$RT/node/bin:$PATH"
node --version

say "arcode from $REPO -> $RT/prefix"
cd "$REPO"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
pack=$(mktemp -d)
tgz=$(npm pack --silent --pack-destination "$pack")
rm -rf "$RT/prefix"
npm install -g --no-audit --no-fund --loglevel=error --prefix "$RT/prefix" "$pack/$tgz"
rm -rf "$pack"
"$RT/prefix/bin/arcode" --help | head -1
echo "commit $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (with uncommitted changes)')" | tee "$RT/BUILD"

say "uv for task containers -> $RT/extra/uv"
mkdir -p "$RT/extra" && cp "$(command -v uv)" "$RT/extra/uv"

say "apptainer + singularity wrapper -> $RT/shim/singularity"
# Harbor calls `singularity exec ... --writable-tmpfs ...`. The wrapper finds the real binary
# (singularity or apptainer) at run time and, when ARCODE_OVERLAY_ROOT is set, swaps
# --writable-tmpfs (RAM-backed, capped by the cluster's "sessiondir max size", 64 MB by default)
# for a fresh on-disk --overlay directory. preflight.slurm decides which mode works.
mkdir -p "$RT/shim"
cat > "$RT/shim/singularity" <<'WRAP'
#!/bin/bash
self_dir=$(cd "$(dirname "$0")" && pwd)
clean_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$self_dir" | paste -sd: -)
REAL=$(PATH=$clean_path command -v singularity || PATH=$clean_path command -v apptainer) || { echo "no singularity/apptainer on PATH" >&2; exit 127; }
if [ -n "${ARCODE_OVERLAY_ROOT:-}" ] && [ "${1:-}" = exec ]; then
  args=()
  for a in "$@"; do
    if [ "$a" = --writable-tmpfs ]; then args+=(--overlay "$(mktemp -d "$ARCODE_OVERLAY_ROOT/ov.XXXXXX")"); else args+=("$a"); fi
  done
  exec "$REAL" "${args[@]}"
fi
exec "$REAL" "$@"
WRAP
chmod +x "$RT/shim/singularity"
command -v apptainer >/dev/null || command -v singularity >/dev/null || module load apptainer 2>/dev/null || module load Apptainer 2>/dev/null || true
export PATH="$RT/shim:$PATH"
singularity --version 2>/dev/null || echo "WARNING: no apptainer/singularity on this login node; preflight checks a compute node"

say "credentials"
if [ -f "$HOME/.arcode/.env" ]; then
  chmod 600 "$HOME/.arcode/.env"
  grep -q '^ARC_API_KEY=' "$HOME/.arcode/.env" && echo "ARC key: ~/.arcode/.env (ok)" || echo "WARNING: ~/.arcode/.env has no ARC_API_KEY= line"
else
  echo "MISSING: ~/.arcode/.env with ARC_API_KEY=... (see integrations/harbor/arc/README.md)"
fi
if [ -f "$HOME/.arcode/dockerhub.env" ]; then
  chmod 600 "$HOME/.arcode/dockerhub.env"; echo "Docker Hub login: ~/.arcode/dockerhub.env (ok)"
else
  echo "optional: ~/.arcode/dockerhub.env (Docker Hub pull limits; see README)"
fi

say "done. Next: sbatch --account=<alloc> integrations/harbor/arc/preflight.slurm"
