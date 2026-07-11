{ inputs, lib, ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs) importNpmLock fetchurl runCommand stdenv;

      nodejs = pkgs.nodejs;

      # ── Helpers ────────────────────────────────────────────────────────

      # Patch npm v3 lockfiles that omit integrity fields for some entries.
      patchLock = name: src: overrides:
        let
          overridesJson = builtins.toJSON overrides;
        in
        runCommand "${name}-patched" {
          inherit overridesJson;
          nativeBuildInputs = [ pkgs.python3 ];
        } ''
          mkdir -p "$out"
          cp -RL ${src}/* "$out/"
          chmod -R u+w "$out"
          if [ -f "$out/package-lock.json" ]; then
            python3 -c "
        import json, os
        overrides = json.loads(os.environ['overridesJson'])
        with open('$out/package-lock.json') as f:
            lock = json.load(f)
        entries = lock.get('packages', {})
        patched = 0
        for key, entry in entries.items():
            if key == ''':
                continue
            if 'integrity' not in entry and 'resolved' in entry:
                url = entry['resolved']
                if url in overrides:
                    entry['integrity'] = overrides[url]
                    patched += 1
        with open('$out/package-lock.json', 'w') as f:
            json.dump(lock, f, indent=2)
        print(f'Patched {patched} entries')
        "
          fi
        '';

      # Build node_modules: fetch with importNpmLock, assemble manually.
      buildNodeModules = name: src: overrides:
        let
          npmRoot = if overrides == { } then src else patchLock name src overrides;
          nmSources = importNpmLock.importNpmLock {
            inherit npmRoot;
          };
        in
        runCommand "${name}-node-modules" {
          nativeBuildInputs = [ nodejs nodejs.passthru.python ];
          passAsFile = [ "linkScript" ];
          linkScript = ''
import json, os, tarfile, tempfile, shutil

out_dir = os.environ["out_dir"]
lockfile = out_dir + "/package-lock.json"
with open(lockfile) as f:
    lock = json.load(f)

packages = lock.get("packages", {})
count = 0
for mod_path, entry in packages.items():
    if mod_path == "":
        continue
    resolved = entry.get("resolved")
    if not resolved or not resolved.startswith("file:"):
        continue
    store_path = resolved[5:]
    if not os.path.exists(store_path):
        continue

    rel = mod_path[len("node_modules/"):]
    target = out_dir + "/node_modules/" + rel
    os.makedirs(os.path.dirname(target), exist_ok=True)

    if os.path.exists(target):
        continue

    if store_path.endswith(".tgz"):
        with tarfile.open(store_path) as tar:
            tmp = tempfile.mkdtemp()
            tar.extractall(path=tmp)
            pkg_dir = os.path.join(tmp, "package")
            if os.path.isdir(pkg_dir):
                for item in os.listdir(pkg_dir):
                    src = os.path.join(pkg_dir, item)
                    dst = os.path.join(target, item)
                    if os.path.isdir(src):
                        shutil.copytree(src, dst, dirs_exist_ok=True)
                    else:
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        shutil.copy2(src, dst)
            shutil.rmtree(tmp)
    else:
        os.symlink(store_path, target)
    count += 1

print(f"Linked {count}/{len(packages)} packages")
'';
        } ''
          mkdir -p "$out/node_modules"

          cp ${nmSources}/package.json "$out/"
          cp ${nmSources}/package-lock.json "$out/"

          out_dir="$out"
          export out_dir
          python3 "$linkScriptPath"

          rm -f "$out/package.json" "$out/package-lock.json"
        '';




      # Build a Pi package with its own node_modules.
      mkPiPackage =
        {
          name,
          src,
          subdir ? null,
          overrides ? { },
        }:
        let
          sourceRoot = if subdir != null then src + "/${subdir}" else src;
          nm = buildNodeModules name sourceRoot overrides;
        in
        runCommand "pi-${name}" { } ''
          mkdir -p "$out"
          cp -R ${sourceRoot}/. "$out/"
          chmod -R u+w "$out"
          rm -rf "$out/node_modules"
          ln -s ${nm}/node_modules "$out/node_modules"
        '';

      # A Pi package with no npm dependencies (just copy source, empty node_modules).
      mkNoDepPackage = name: src: runCommand "pi-${name}" { } ''
        mkdir -p "$out"
        cp -R ${src}/. "$out/"
        chmod -R u+w "$out"
        mkdir -p "$out/node_modules"
      '';

      # ── Integrity overrides ────────────────────────────────────────────
      # Resolved URL → sha512-... for entries where npm v3 omitted integrity.

      hypaOverrides = {
        "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.79.8.tgz" =
          "sha512-8m5fcqRpoGpq3QY0I/tFXROSTmPwBb1dAuzYZO3XYgjsdCokkRMAGRjA9P8s/UD6Jy9yy69lyE4H6sz/5A1TmQ==";
        "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.79.8.tgz" =
          "sha512-ZpSwaD7oNpsjn9vtEatZQNT9PSdDJXi6rFeY5Qv+OHQGFDKlmcrfJE4ypm4SAc/fBECPs4Rdi3l+YjVtXYrkKw==";
        "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.79.8.tgz" =
          "sha512-QerB+0wUc6eEO8MwvzOQGtzcsbwo6y8VvdxYU6vGcakz6ofJZWhrmwrknp1dCGx3bEtCf+siUIxEzkqvFCzIsg==";
      };

      webSearchOverrides = {
        "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.80.3.tgz" =
          "sha512-3qw0/GeRQBU/nlGjDe5Yb7ePKTmoxefx2YxyKMFAviFUMXpFexBG/hS7mBtwFahFvzrrTPPoRT6sFIDjwoDWPQ==";
        "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.80.3.tgz" =
          "sha512-jPZLMeGL5kkMSEAwAklfXTMHqZvfhsJtCCpKGIr5Duk7mc0n4skjB1dugk7y0z3z8ZHIUCmPAWHdyDqgUz5vdA==";
        "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.80.3.tgz" =
          "sha512-2BJI6qwRQfnM0Q7seL1+SbacU/jRRjBnN7Hu3n9BjAn7/s5FaBNnvdD1qBQYRsFTHfjqMaDsjYqanPyqwXj99w==";
      };

      mcpOverrides = {
        "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.79.10.tgz" =
          "sha512-XKxgdjhcPuyjrthCOFSgfzT3xZ1uBrJ1IMVDxci1to6hIN6BIg9J5iY8q0pGXK1DLgATLP23da+1UyZLwA360Q==";
        "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.79.10.tgz" =
          "sha512-9jR23tOl0BIUdQMn70Gr72xYBpM7Xgl9Lyv7gAnU1USfkNRuYG/f/edLl+n/Dp/RafDW3JI4DF7y/GhgkORuew==";
        "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.79.10.tgz" =
          "sha512-FUVOjDn1DVwM1uHD5MNYboXQrXjIDbSt+BQ3py7nQWCY62tKfxgiM1OBMxTcwRWLfSdZHUPpV0hm1loIdUJnPw==";
      };

      # ── Pi packages ────────────────────────────────────────────────────

      pi-hypa = mkPiPackage {
        name = "hypa";
        src = inputs.pi-hypa;
        subdir = "packages/pi-hypa";
        overrides = hypaOverrides;
      };

      pi-context-tools = mkPiPackage {
        name = "context-tools";
        src = inputs.pi-context-tools;
      };

      pi-mcp-adapter = mkPiPackage {
        name = "mcp-adapter";
        src = inputs.pi-mcp-adapter;
        overrides = mcpOverrides;
      };

      pi-subagents = mkPiPackage {
        name = "subagents";
        src = inputs.pi-subagents;
      };

      pi-lsp = mkNoDepPackage "lsp" (fetchurl {
        url = "https://registry.npmjs.org/pi-lsp/-/pi-lsp-0.1.7.tgz";
        hash = "sha256-75WAW5kBWlXhmaHIRhfY/xWtgXPWyFASIG634J8CGoc=";
      });

      pi-reduce = mkPiPackage {
        name = "reduce";
        src = inputs.pi-reduce;
      };

      pi-web-search = mkPiPackage {
        name = "web-search";
        src = inputs.pi-web-search;
        overrides = webSearchOverrides;
      };

      rpiv-web-tools = let
        rpiv-config = fetchurl {
          url = "https://registry.npmjs.org/@juicesharp/rpiv-config/-/rpiv-config-1.20.0.tgz";
          hash = "sha256-Xd/v2Id/pDLwnTMKKWri4orvVnxOSQ9uxcBRtudcTWI=";
        };
        typebox = fetchurl {
          url = "https://registry.npmjs.org/typebox/-/typebox-1.3.6.tgz";
          hash = "sha256-XKQmbhiguu6Fvt8TTpqTpnNS2WOsIf6g8+c9sBwS1dE=";
        };
        webSrc = fetchurl {
          url = "https://registry.npmjs.org/@juicesharp/rpiv-web-tools/-/rpiv-web-tools-1.20.0.tgz";
          hash = "sha256-Uwj9n+Ptg5ER2pMIMWOgfYKY21Nw1rQvkATn9qa8sd0=";
        };
      in runCommand "pi-rpiv-web-tools" { } ''
        mkdir -p "$out"
        tar -xzf ${webSrc} -C "$out"
        mv "$out/package"/* "$out/"
        rmdir "$out/package"
        mkdir -p "$out/node_modules/@juicesharp"
        tar -xzf ${rpiv-config} -C "$out/node_modules/@juicesharp"
        mv "$out/node_modules/@juicesharp/package" "$out/node_modules/@juicesharp/rpiv-config"
        tar -xzf ${typebox} -C "$out/node_modules"
        mv "$out/node_modules/package" "$out/node_modules/typebox"
      '';

      # Phenix shell — the package that wires everything together
      phenixShell = mkNoDepPackage "phenix-shell" ./phenix-pi;

      # ── Package map for the combined derivation ────────────────────────
      piPackageMap = {
        "@hypabolic/pi-hypa" = pi-hypa;
        "@juicesharp/rpiv-web-tools" = rpiv-web-tools;
        "pi-context-tools" = pi-context-tools;
        "pi-lsp" = pi-lsp;
        "pi-mcp-adapter" = pi-mcp-adapter;
        "pi-reduce" = pi-reduce;
        "pi-subagents" = pi-subagents;
        "pi-web-search" = pi-web-search;
      };

      # Combined derivation: shell + all Pi packages linked into node_modules.
      combined = stdenv.mkDerivation {
        name = "phenix-pi-packages";
        src = lib.cleanSource ./phenix-pi;
        dontConfigure = true;
        dontBuild = true;
        passAsFile = [ "linkScript" ];

        linkScript = builtins.concatStringsSep "\n" (
          builtins.map (npmName: let
            drv = piPackageMap.${npmName};
            parentDir = builtins.dirOf npmName;
            mkdirCmd = if parentDir == "." then "" else "mkdir -p \"$out/node_modules/${parentDir}\"";
          in ''
            ${mkdirCmd}
            ln -s ${drv} "$out/node_modules/${npmName}"
            _nmods=${drv}/node_modules
            if [ -d "$_nmods" ]; then
              find "$_nmods" -maxdepth 2 -mindepth 2 -type d 2>/dev/null | while read dir; do
                rel="''${dir#$_nmods/}"
                rel="''${rel#/}"
                dst="$out/node_modules/$rel"
                [ -e "$dst" ] || ln -s "$dir" "$dst"
              done
              find "$_nmods" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | while read dir; do
                base="$(basename "$dir")"
                case "$base" in @*) ;; *)
                  dst="$out/node_modules/$base"
                  [ -e "$dst" ] || ln -s "$dir" "$dst"
                ;; esac
              done
            fi
          '') (builtins.attrNames piPackageMap)
        );

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -r "$src"/* "$out/"
          chmod -R u+w "$out"
          rm -rf "$out/node_modules"
          mkdir -p "$out/node_modules"
          . "$linkScriptPath"
          runHook postInstall
        '';
      };
    in
    {
      packages = {
        inherit
          pi-hypa
          rpiv-web-tools
          pi-context-tools
          pi-lsp
          pi-mcp-adapter
          pi-subagents
          pi-reduce
          pi-web-search
          ;
        phenix-pi-packages = combined;
      };
      checks = { phenix-pi-packages = combined; };
    };
}
