#
# Build FreeTDS from source (static) and compile the native addon for Windows x64.
#
# Prerequisites:
#   - Visual Studio 2022 (or Build Tools) with C++ workload
#   - CMake (included with VS)
#   - node-gyp: npm install -g node-gyp
#   - Node.js headers
#
# This script:
# 1. Downloads & compiles FreeTDS (both shared sybdb + static db-lib targets)
# 2. Builds the N-API addon linked against the STATIC db-lib target
# 3. Copies the result to src/native/
#
# FreeTDS CMake always builds:
#   - sybdb (SHARED) → sybdb.dll + sybdb.lib (import library) — DO NOT link this
#   - db-lib (STATIC) → db-lib.lib (true static library) — link this one
#   - tds (STATIC), replacements (STATIC), tdsutils (STATIC)
#
$ErrorActionPreference = "Stop"

$FreeTdsVersion = if ($env:FREETDS_VERSION) { $env:FREETDS_VERSION } else { "1.5.17" }
$RootDir = Resolve-Path "$PSScriptRoot\.."
$DepsDir = Join-Path $RootDir "deps\freetds"
$BuildDir = Join-Path $RootDir "build-freetds"

Write-Host "Building for platform: win32-x64"
Write-Host "FreeTDS version: $FreeTdsVersion"
Write-Host "Root dir: $RootDir"

# ---------------------------------------------------------------------------
# Step 1: Download and compile FreeTDS
# ---------------------------------------------------------------------------

# SHA-256 of each FreeTDS release tarball (as in scripts/build.sh).
$FreeTdsSha256 = @{ "1.5.17" = "8d154ce458d1825a8625b0ef1c3288afecfc32b3a09015a5ece4fbdf8aafd144" }[$FreeTdsVersion]
if (-not $FreeTdsSha256) { throw "No known SHA-256 for FreeTDS $FreeTdsVersion: add it to scripts/build-win.ps1" }

# The same patches scripts/build.sh and the release workflow apply. They need
# GNU patch (it comes with Git for Windows: Git\usr\bin).
$Patches = @(Get-ChildItem -Path (Join-Path $RootDir "patches") -Filter "freetds-$FreeTdsVersion-*.patch" | Sort-Object Name)

# How FreeTDS is configured: used for the build and, with what else it depends
# on, for its identity — a build made from anything else is rebuilt.
$CmakeArgs = @(
  "-G", "Visual Studio 17 2022", "-A", "x64",
  "-DCMAKE_INSTALL_PREFIX=$DepsDir",
  "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
  "-DWITH_OPENSSL=OFF",
  "-DENABLE_ODBC=OFF"
)
$CmakeVersion = (cmake --version | Select-Object -First 1)
$IdText = "$FreeTdsVersion $FreeTdsSha256 win32-x64 $($CmakeArgs -join ' ') $CmakeVersion`n" + (($Patches | ForEach-Object { Get-Content -Raw $_.FullName }) -join "")
$BuildId = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($IdText))
).Replace("-", "")
$IdFile = Join-Path $DepsDir ".build-id"

$LibFile = Join-Path $DepsDir "lib\db-lib.lib"
if ((Test-Path $LibFile) -and (-not (Test-Path $IdFile) -or (Get-Content -Raw $IdFile).Trim() -ne $BuildId)) {
  Write-Host "==> FreeTDS in $DepsDir was built for another version, configuration or patch set; rebuilding"
  Remove-Item -Recurse -Force $DepsDir
}
if (-not (Test-Path $LibFile)) {
  Write-Host "==> Downloading FreeTDS $FreeTdsVersion..."
  New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
  Set-Location $BuildDir

  $Tarball = "freetds-$FreeTdsVersion.tar.gz"
  # The package's own copy when there (vendor/), else a download.
  $Vendored = Join-Path $RootDir "vendor\$Tarball"
  if (Test-Path $Vendored) {
    Copy-Item $Vendored $Tarball -Force
  } elseif (-not (Test-Path $Tarball)) {
    curl.exe -fsSL "https://www.freetds.org/files/stable/freetds-$FreeTdsVersion.tar.gz" -o $Tarball
    if ($LASTEXITCODE -ne 0) { throw "Failed to download FreeTDS" }
  }
  if ((Get-FileHash -Algorithm SHA256 $Tarball).Hash.ToLower() -ne $FreeTdsSha256) {
    throw "$BuildDir\$Tarball does not match its known SHA-256; refusing to build it"
  }

  Write-Host "==> Extracting..."
  if (Test-Path "freetds-$FreeTdsVersion") { Remove-Item -Recurse -Force "freetds-$FreeTdsVersion" }
  tar xzf $Tarball
  if ($LASTEXITCODE -ne 0) { throw "Failed to extract tarball" }
  Set-Location "freetds-$FreeTdsVersion"

  foreach ($Patch in $Patches) {
    Write-Host "==> Applying $($Patch.Name)"
    patch -p1 --forward --quiet -i $Patch.FullName
    if ($LASTEXITCODE -ne 0) { throw "Failed to apply $($Patch.Name) (GNU patch from Git for Windows is needed)" }
  }

  Write-Host "==> Configuring FreeTDS (MSVC x64, /MD runtime)..."
  cmake -B build @CmakeArgs
  if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }

  Write-Host "==> Compiling..."
  cmake --build build --config Release --parallel
  if ($LASTEXITCODE -ne 0) { throw "CMake build failed" }

  Write-Host "==> Installing to $DepsDir..."
  cmake --install build --config Release
  if ($LASTEXITCODE -ne 0) { throw "CMake install failed" }
  Set-Content -Path $IdFile -Value $BuildId

  Set-Location $RootDir
  Write-Host "==> FreeTDS built successfully"
} else {
  Write-Host "==> FreeTDS static library already exists at $LibFile"
}

# Verify the static lib exists (not the import lib)
if (-not (Test-Path $LibFile)) {
  throw "db-lib.lib not found at $LibFile. CMake install may have failed."
}
$ImportLib = Join-Path $DepsDir "lib\sybdb.lib"
if (Test-Path $ImportLib) {
  Write-Host "  WARNING: sybdb.lib (import library) also exists — binding.gyp links db-lib.lib (static) instead"
}

# ---------------------------------------------------------------------------
# Step 2: Build the N-API addon
# ---------------------------------------------------------------------------

Write-Host "==> Building native addon..."
Set-Location $RootDir
# Some Node 26 Windows builds enable thin-LTO, so node-gyp inherits Clang LTO
# flags (-flto=thin and /opt:lldltojobs=N) that MSVC's link.exe rejects
# (LNK1117). binding.gyp strips those flags on Windows; the -D flags are a
# secondary lever for config.gypi files that use the %-default form.
npx node-gyp rebuild -Denable_lto=false -Denable_thin_lto=false
if ($LASTEXITCODE -ne 0) { throw "node-gyp rebuild failed" }

# ---------------------------------------------------------------------------
# Step 3: Copy to src/native/ for development
# ---------------------------------------------------------------------------

$NodeFile = "sybase_native.win32-x64.node"
$Source = Join-Path $RootDir "build\Release\sybase_native.node"
$DestDir = Join-Path $RootDir "src\native"
$Dest = Join-Path $DestDir $NodeFile

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Copy-Item $Source $Dest -Force
# The installed package loads it from dist/native.
$DistDir = Join-Path $RootDir "dist\native"
if (Test-Path $DistDir) { Copy-Item $Source (Join-Path $DistDir $NodeFile) -Force }

# Verify no dynamic dependency on sybdb.dll
$Content = [System.IO.File]::ReadAllBytes($Dest)
$AsciiStr = [System.Text.Encoding]::ASCII.GetString($Content)
if ($AsciiStr -match "sybdb\.dll") {
  throw "ERROR: The built .node file still depends on sybdb.dll! Static linking failed."
}

$Size = (Get-Item $Dest).Length
Write-Host ""
Write-Host "=== Build complete ==="
Write-Host "  Platform: win32-x64"
Write-Host "  Addon:    src/native/$NodeFile"
Write-Host "  Size:     $([math]::Round($Size / 1024))KB"
Write-Host "  Status:   No sybdb.dll dependency (fully static)"
