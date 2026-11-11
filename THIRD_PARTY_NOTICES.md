# Third-party notices

## FreeTDS

The native binaries in this package (`dist/native/sybase_native.*.node`) contain
[FreeTDS](https://www.freetds.org/) 1.5.17, statically linked: its db-lib and
libTDS libraries, licensed under the GNU Library General Public License, version
2 or later. The license text is in
[licenses/FreeTDS-COPYING_LIB.txt](licenses/FreeTDS-COPYING_LIB.txt).

FreeTDS is modified by the patches in [patches/](patches/) (each says what it
changes and why; each file changed carries a notice saying so, and when). The
source it is built from is in this package:

- the FreeTDS 1.5.17 release tarball, `vendor/freetds-1.5.17.tar.gz` — as
  published at <https://www.freetds.org/files/stable/freetds-1.5.17.tar.gz>
  (SHA-256 `8d154ce458d1825a8625b0ef1c3288afecfc32b3a09015a5ece4fbdf8aafd144`),
- the patches in `patches/`, applied to it,
- the addon's own source (`src/native/binding.c`, `binding.gyp`) and the build
  scripts (`scripts/`).

To link the addon against a modified FreeTDS, change or add a patch and run
`scripts/build.sh` (or `scripts/build-win.ps1` on Windows) from the package's
directory: it rebuilds FreeTDS from that source — no download needed — and then
the addon, and puts it where the package loads it from.
