#!/usr/bin/env bash
#
# Solana + Anchor toolchain setup.
#
# Run inside WSL (Ubuntu) on Windows, or natively on Linux/macOS. Anchor's build
# shells out to cargo-build-sbf, which does not work reliably on native Windows —
# WSL is the supported path, not a workaround.
#
#   bash scripts/setup-anchor.sh
#
# Idempotent: re-running skips anything already present.

set -euo pipefail

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  warn "This looks like Git Bash on Windows, not WSL."
  warn "Anchor builds will fail here. Open an Ubuntu (WSL) shell and re-run."
  exit 1
fi

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
if have apt-get; then
  log "Installing build dependencies"
  sudo apt-get update -qq
  # Solana and Anchor need a C toolchain, OpenSSL headers, and protobuf.
  sudo apt-get install -y -qq \
    build-essential pkg-config libssl-dev libudev-dev \
    llvm libclang-dev protobuf-compiler curl git
fi

# ---------------------------------------------------------------------------
# Rust
# ---------------------------------------------------------------------------
if have rustc; then
  log "Rust already installed: $(rustc --version)"
else
  log "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# ---------------------------------------------------------------------------
# Solana CLI  (Anza took over maintenance from Solana Labs)
# ---------------------------------------------------------------------------
if have solana; then
  log "Solana CLI already installed: $(solana --version)"
else
  log "Installing Solana CLI"
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# ---------------------------------------------------------------------------
# Anchor, via AVM
# ---------------------------------------------------------------------------
if have anchor; then
  log "Anchor already installed: $(anchor --version)"
else
  log "Installing AVM (Anchor Version Manager) — this compiles from source and is slow"
  cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
  avm install latest
  avm use latest
fi

# ---------------------------------------------------------------------------
# PATH persistence
# ---------------------------------------------------------------------------
SHELL_RC="$HOME/.bashrc"
[[ -n "${ZSH_VERSION:-}" ]] && SHELL_RC="$HOME/.zshrc"

add_path() {
  grep -qF "$1" "$SHELL_RC" 2>/dev/null || echo "export PATH=\"$1:\$PATH\"" >> "$SHELL_RC"
}
add_path "\$HOME/.cargo/bin"
add_path "\$HOME/.local/share/solana/install/active_release/bin"

# ---------------------------------------------------------------------------
# A keypair for local development
# ---------------------------------------------------------------------------
if [[ ! -f "$HOME/.config/solana/id.json" ]]; then
  log "Generating a local development keypair"
  warn "This key is for localnet only. Never fund it, never reuse it on mainnet."
  solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json"
fi

solana config set --url localhost >/dev/null

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
log "Done"
printf '  rust    %s\n' "$(rustc --version 2>/dev/null || echo MISSING)"
printf '  cargo   %s\n' "$(cargo --version 2>/dev/null || echo MISSING)"
printf '  solana  %s\n' "$(solana --version 2>/dev/null || echo MISSING)"
printf '  anchor  %s\n' "$(anchor --version 2>/dev/null || echo MISSING)"
printf '\n  Open a new shell (or: source %s) so PATH takes effect.\n' "$SHELL_RC"
printf '  Then: solana-test-validator   to run a local chain.\n\n'
