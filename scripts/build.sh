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
# 1. Downloads & compiles FreeTDS as a static library
# 2. Builds the N-API addon linked against it
# 3. Copies the result to the appropriate npm/ platform directory
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

if [ ! -f "$DEPS_DIR/lib/libsybdb.a" ]; then
  echo "==> Downloading FreeTDS $FREETDS_VERSION..."
  mkdir -p "$BUILD_DIR"
  cd "$BUILD_DIR"

  TARBALL="freetds-$FREETDS_VERSION.tar.gz"
  if [ ! -f "$TARBALL" ]; then
    curl -fsSL "https://www.freetds.org/files/stable/freetds-$FREETDS_VERSION.tar.gz" -o "$TARBALL"
  fi

  echo "==> Extracting..."
  tar xzf "$TARBALL"
  cd "freetds-$FREETDS_VERSION"

  echo "==> Configuring FreeTDS (static only)..."
  # CFLAGS=-fPIC is required on Linux — static library objects must be
  # position-independent to link into a shared object (.node addon).
  # On macOS cross-compiling x64 from arm64, add -arch x86_64.
  EXTRA_CFLAGS="-fPIC -O2"
  CONFIGURE_HOST=""
  if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ] && [ "$(uname -m)" = "arm64" ]; then
    EXTRA_CFLAGS="$EXTRA_CFLAGS -arch x86_64"
    CONFIGURE_HOST="--host=x86_64-apple-darwin"
  fi

  CFLAGS="$EXTRA_CFLAGS" ./configure \
    --prefix="$DEPS_DIR" \
    --enable-static \
    --disable-shared \
    --with-tdsver=5.0 \
    --disable-odbc \
    --disable-apps \
    --disable-server \
    --disable-pool \
    --without-openssl \
    $CONFIGURE_HOST \
    --quiet

  echo "==> Compiling..."
  make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" --quiet

  echo "==> Installing to $DEPS_DIR..."
  make install --quiet

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

echo "==> Copying addon to src/native/${NODE_FILE}"
cp "$ROOT_DIR/build/Release/sybase_native.node" "$ROOT_DIR/src/native/${NODE_FILE}"

echo ""
echo "=== Build complete ==="
echo "  Platform: $PLATFORM"
echo "  Addon:    src/native/${NODE_FILE}"
echo "  Size:     $(du -h "$ROOT_DIR/src/native/${NODE_FILE}" | cut -f1)"
