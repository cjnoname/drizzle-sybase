#!/usr/bin/env bash
#
# Build FreeTDS from source and compile the native addon for the current platform.
#
# Prerequisites:
#   - C compiler (gcc/clang)
#   - node-gyp: npm install -g node-gyp
#   - Node.js headers
#
# This script:
# 1. Takes the FreeTDS source — vendor/freetds-<version>.tar.gz when there (as
#    in the published package), else downloaded — checks its SHA-256, applies
#    patches/freetds-<version>-*.patch, and compiles it as a static library
# 2. Builds the N-API addon linked against it
# 3. Copies the result to src/native (and dist/native when it exists)
#
#   bash scripts/build.sh                 # build
#   bash scripts/build.sh --fetch-source  # only put the checked source in vendor/
#
set -euo pipefail

FREETDS_VERSION="${FREETDS_VERSION:-1.5.17}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DEPS_DIR="$ROOT_DIR/deps/freetds"
BUILD_DIR="$ROOT_DIR/build-freetds"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Normalize arch
case "$ARCH" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
esac

# Support cross-compilation via TARGET_ARCH env var (e.g. TARGET_ARCH=x64 on ARM64 Mac)
if [ -n "${TARGET_ARCH:-}" ]; then
  ARCH="$TARGET_ARCH"
fi

PLATFORM="${OS}-${ARCH}"
echo "Building for platform: $PLATFORM"
echo "FreeTDS version: $FREETDS_VERSION"

# ---------------------------------------------------------------------------
# Step 1: Download and compile FreeTDS as static library
# ---------------------------------------------------------------------------

# SHA-256 of each FreeTDS release tarball this script builds (checked before it
# is extracted, also when cached). A version not listed here is refused.
case "$FREETDS_VERSION" in
  1.5.17) FREETDS_SHA256=8d154ce458d1825a8625b0ef1c3288afecfc32b3a09015a5ece4fbdf8aafd144 ;;
  *) echo "No known SHA-256 for FreeTDS $FREETDS_VERSION: add it to scripts/build.sh" >&2; exit 1 ;;
esac

sha256() { (shasum -a 256 "$@" 2>/dev/null || sha256sum "$@") | cut -d' ' -f1; }

TARBALL="freetds-$FREETDS_VERSION.tar.gz"
VENDORED="$ROOT_DIR/vendor/$TARBALL"

# The FreeTDS release tarball, checked, at `$1`: the vendored copy, else a
# download. Nothing that does not match its known SHA-256 is ever used.
fetch_source() {
  local dest="$1"
  if [ -f "$VENDORED" ] && [ "$VENDORED" != "$dest" ]; then
    cp "$VENDORED" "$dest"
  elif [ ! -f "$dest" ]; then
    curl -fsSL "https://www.freetds.org/files/stable/$TARBALL" -o "$dest"
  fi
  if [ "$(sha256 "$dest")" != "$FREETDS_SHA256" ]; then
    echo "$dest does not match the known SHA-256 of $TARBALL; refusing to use it" >&2
    exit 1
  fi
}

if [ "${1:-}" = "--fetch-source" ]; then
  mkdir -p "$ROOT_DIR/vendor"
  fetch_source "$VENDORED"
  echo "==> $VENDORED"
  exit 0
fi

# Patches applied to FreeTDS (see each file's header); there may be none.
shopt -s nullglob
PATCHES=("$ROOT_DIR"/patches/freetds-"$FREETDS_VERSION"-*.patch)
shopt -u nullglob

# CFLAGS=-fPIC is required on Linux — static library objects must be
# position-independent to link into a shared object (.node addon).
# On macOS cross-compiling x64 from arm64, add -arch x86_64.
EXTRA_CFLAGS="-fPIC -O2"
CONFIGURE_ARGS=(
  --prefix="$DEPS_DIR"
  --enable-static
  --disable-shared
  --with-tdsver=5.0
  --disable-odbc
  --disable-apps
  --disable-server
  --disable-pool
  --without-openssl
  --quiet
)
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ] && [ "$(uname -m)" = "arm64" ]; then
  EXTRA_CFLAGS="$EXTRA_CFLAGS -arch x86_64"
  CONFIGURE_ARGS+=(--host=x86_64-apple-darwin)
fi

# What the FreeTDS build depends on: version, source, patches, target, flags,
# configure options and compiler — and what configure takes from the
# environment besides (CFLAGS is set here). A build made from anything else is
# rebuilt, so a stale or foreign libsybdb.a (another architecture's, say) is
# never linked.
BUILD_ID="$(
  {
    echo "$FREETDS_VERSION $FREETDS_SHA256 $PLATFORM $EXTRA_CFLAGS ${CONFIGURE_ARGS[*]}"
    echo "CC=${CC-} CPP=${CPP-} CPPFLAGS=${CPPFLAGS-} LDFLAGS=${LDFLAGS-} LIBS=${LIBS-}"
    "${CC:-cc}" --version 2>/dev/null | head -1 || true
    if [ ${#PATCHES[@]} -gt 0 ]; then cat "${PATCHES[@]}"; fi
  } | (shasum -a 256 2>/dev/null || sha256sum) | cut -d' ' -f1
)"
if [ -f "$DEPS_DIR/lib/libsybdb.a" ] && [ "$(cat "$DEPS_DIR/.build-id" 2>/dev/null)" != "$BUILD_ID" ]; then
  echo "==> FreeTDS in $DEPS_DIR was built for another version, target or patch set; rebuilding"
  rm -rf "$DEPS_DIR"
fi

if [ ! -f "$DEPS_DIR/lib/libsybdb.a" ]; then
  echo "==> FreeTDS $FREETDS_VERSION source..."
  mkdir -p "$BUILD_DIR"
  cd "$BUILD_DIR"
  fetch_source "$BUILD_DIR/$TARBALL"

  echo "==> Extracting..."
  rm -rf "freetds-$FREETDS_VERSION"
  tar xzf "$TARBALL"
  cd "freetds-$FREETDS_VERSION"

  for PATCH in "${PATCHES[@]}"; do
    echo "==> Applying $(basename "$PATCH")"
    patch -p1 --forward --quiet < "$PATCH"
  done

  echo "==> Configuring FreeTDS (static only)..."
  CFLAGS="$EXTRA_CFLAGS" ./configure "${CONFIGURE_ARGS[@]}"

  echo "==> Compiling..."
  make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" --quiet

  echo "==> Installing to $DEPS_DIR..."
  make install --quiet
  echo "$BUILD_ID" > "$DEPS_DIR/.build-id"

  cd "$ROOT_DIR"
  echo "==> FreeTDS static library built successfully"
else
  echo "==> FreeTDS static library already exists at $DEPS_DIR/lib/libsybdb.a"
fi

# ---------------------------------------------------------------------------
# Step 2: Build the N-API addon
# ---------------------------------------------------------------------------

echo "==> Building native addon..."
cd "$ROOT_DIR"
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ] && [ "$(uname -m)" = "arm64" ]; then
  # Cross-compile x64 addon on ARM64 Mac
  npx node-gyp rebuild --arch=x64
else
  npx node-gyp rebuild
fi

# ---------------------------------------------------------------------------
# Step 3: Copy to src/native/ for development and dist/native/ for publishing
# ---------------------------------------------------------------------------

# Determine the platform-specific filename
NODE_FILE="sybase_native.${OS/linux/linux}-${ARCH}.node"
if [ "$OS" = "darwin" ]; then
  NODE_FILE="sybase_native.darwin-${ARCH}.node"
fi

# Both places the loader may load it from: src/native in this repo, dist/native
# in the installed package (where src/ holds no loader).
echo "==> Copying addon to src/native/${NODE_FILE}"
cp "$ROOT_DIR/build/Release/sybase_native.node" "$ROOT_DIR/src/native/${NODE_FILE}"
if [ -d "$ROOT_DIR/dist/native" ]; then
  echo "==> Copying addon to dist/native/${NODE_FILE}"
  cp "$ROOT_DIR/build/Release/sybase_native.node" "$ROOT_DIR/dist/native/${NODE_FILE}"
fi

echo ""
echo "=== Build complete ==="
echo "  Platform: $PLATFORM"
echo "  Addon:    src/native/${NODE_FILE}"
echo "  Size:     $(du -h "$ROOT_DIR/src/native/${NODE_FILE}" | cut -f1)"
