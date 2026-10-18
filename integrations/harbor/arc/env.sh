# Sourced by preflight.slurm and generate.slurm: the job environment for Harbor + Apptainer on ARC.
# Everything large (images, layer cache, apptainer temp) goes to node-local disk and is removed at exit.

RT=${ARCODE_RT:-$HOME/arcode-rt}
[ -x "$RT/prefix/bin/arcode" ] || { echo "no arcode runtime in $RT: run integrations/harbor/arc/setup.sh on a login node first"; exit 1; }
command -v apptainer >/dev/null || command -v singularity >/dev/null || module load apptainer 2>/dev/null || module load Apptainer 2>/dev/null || true
export PATH="$RT/shim:$HOME/.local/bin:$PATH"   # shim/singularity wraps the real binary (setup.sh)
singularity --version >/dev/null 2>&1 || { echo "singularity/apptainer not found on $(hostname)"; exit 1; }
PY="$(uv tool dir)/harbor/bin/python"   # Harbor's own Python 3.12 (run_rebench.py is stdlib only)
export PYTHONNOUSERSITE=1

# Node + arcode, read-only inside every task container (the adapter's HPC mode looks here).
export ARCODE_RUNTIME=/opt/arcode-rt
export APPTAINER_BIND="$RT:$ARCODE_RUNTIME:ro" SINGULARITY_BIND="$RT:$ARCODE_RUNTIME:ro"

# Node-local scratch for images: several GB each, pulled and deleted per batch.
SCRATCH_ROOT=${ARCODE_SCRATCH:-${TMPDIR:-/tmp}}
WORK="$SCRATCH_ROOT/arcode-$USER-${SLURM_JOB_ID:-$$}"
mkdir -p "$WORK/sif" "$WORK/cache" "$WORK/tmp"
export APPTAINER_CACHEDIR="$WORK/cache" APPTAINER_TMPDIR="$WORK/tmp"
export SINGULARITY_CACHEDIR="$WORK/cache" SINGULARITY_TMPDIR="$WORK/tmp"
trap 'rm -rf "$WORK"' EXIT

# Container scratch layer: RAM tmpfs (Harbor's default) or on-disk overlay dirs, as preflight found.
OVERLAY_MODE=$(cat "$RT/overlay_mode" 2>/dev/null || echo tmpfs)
if [ "$OVERLAY_MODE" = dir ]; then
  export ARCODE_OVERLAY_ROOT="$WORK/overlay"
  mkdir -p "$ARCODE_OVERLAY_ROOT"
fi

# Optional Docker Hub login (anonymous pulls are rate-limited per IP, and a cluster shares IPs).
# File format: APPTAINER_DOCKER_USERNAME=... and APPTAINER_DOCKER_PASSWORD=<access token>
if [ -f "$HOME/.arcode/dockerhub.env" ]; then
  set -a; . "$HOME/.arcode/dockerhub.env"; set +a
fi

echo "host $(hostname) | job ${SLURM_JOB_ID:-none} | cpus ${SLURM_CPUS_PER_TASK:-?} | $(singularity --version)"
echo "arcode runtime: $(cat "$RT/BUILD" 2>/dev/null) | harbor $(harbor --version) | $("$PY" -V)"
echo "scratch $WORK: $(df -h "$WORK" | awk 'NR==2 {print $4 " free"}') | container overlay: $OVERLAY_MODE"
