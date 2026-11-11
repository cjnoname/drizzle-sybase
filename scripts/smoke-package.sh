#!/usr/bin/env bash
#
# Pack this package as it would be published, check what the tarball holds,
# install it into an empty project as an application would, and load it there:
# on Linux in AWS Lambda's Node.js 24 image (Amazon Linux 2023, glibc 2.34) for
# this machine's architecture, elsewhere with the Node.js running this script.
# Catches a tarball missing a binary, its loader or the material to rebuild it,
# and a Linux binary Lambda cannot load.
#
#   bash scripts/smoke-package.sh
#
# Needs dist/ built with every platform's binary in dist/native, the FreeTDS
# source in vendor/ (scripts/build.sh --fetch-source), and Docker on Linux.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT_DIR"
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/drizzle-sybase-*.tgz)"
mkdir "$WORK/unpacked"
tar -xzf "$TARBALL" -C "$WORK/unpacked"
PKG="$WORK/unpacked/package"

# Every binary, and not an empty placeholder.
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do
  if [ ! -s "$PKG/dist/native/sybase_native.$p.node" ]; then
    echo "The tarball has no binary for $p (or an empty one)" >&2
    exit 1
  fi
done

# What rebuilding the binaries against a modified FreeTDS takes (see
# THIRD_PARTY_NOTICES.md): its source, the patches, the addon's source and the
# build scripts — and the license and notices.
# shellcheck disable=SC2016 # the $ in the pattern is build.sh's own text
FREETDS_VERSION="$(sed -n 's/^FREETDS_VERSION="\${FREETDS_VERSION:-\(.*\)}"$/\1/p' scripts/build.sh)"
for f in "vendor/freetds-$FREETDS_VERSION.tar.gz" src/native/binding.c binding.gyp \
  scripts/build.sh scripts/build-win.ps1 THIRD_PARTY_NOTICES.md licenses/FreeTDS-COPYING_LIB.txt \
  LICENSE; do
  if [ ! -s "$PKG/$f" ]; then
    echo "The tarball is missing $f" >&2
    exit 1
  fi
done
for patch in patches/freetds-"$FREETDS_VERSION"-*.patch; do
  if ! cmp -s "$patch" "$PKG/$patch"; then
    echo "The tarball's $patch differs from the repository's" >&2
    exit 1
  fi
done
# Nothing that should never be published.
if (cd "$PKG" && find . -name '.env*' -o -name '*.pem' -o -name 'id_rsa*' | grep -q .); then
  echo "The tarball holds files that must not be published:" >&2
  (cd "$PKG" && find . -name '.env*' -o -name '*.pem' -o -name 'id_rsa*') >&2
  exit 1
fi

DRIZZLE="$(node -p "require('./package.json').peerDependencies['drizzle-orm']")"
mkdir "$WORK/app"
cd "$WORK/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$TARBALL" "drizzle-orm@$DRIZZLE" >/dev/null
cp "$ROOT_DIR/scripts/smoke-native.ts" "$WORK/"

if [ "$(uname -s)" = "Linux" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) DOCKER_PLATFORM=linux/amd64 ;;
    arm64 | aarch64) DOCKER_PLATFORM=linux/arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  docker run --rm --pull always --platform "$DOCKER_PLATFORM" --entrypoint node -v "$WORK:/w" -w /w/app \
    public.ecr.aws/lambda/nodejs:24 \
    /w/smoke-native.ts --package /w/app
else
  node "$WORK/smoke-native.ts" --package "$WORK/app"
fi
