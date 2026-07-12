from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

nix_path = ROOT / "modules/pi-packages.nix"
nix = nix_path.read_text()

runtime_end = '''      phenixRuntimeTests =
        pkgs.runCommand "phenix-runtime-tests"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.ast-grep
              pkgs.git
            ];
          }
          ''
            cd ${phenixPiPackage}
            node --experimental-strip-types --test tests/*.test.ts
            node --check runtime/verify.mjs
            touch "$out"
          '';
'''

typecheck = runtime_end + '''

      phenixTypecheck =
        pkgs.runCommand "phenix-typecheck"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.typescript
            ];
          }
          ''
            cd ${phenixPiPackage}
            tsc --project tsconfig.json --pretty false
            touch "$out"
          '';
'''

if nix.count(runtime_end) != 1:
    raise RuntimeError("could not locate runtime test derivation")
nix = nix.replace(runtime_end, typecheck, 1)

nix = nix.replace(
    "        phenix-runtime-tests = phenixRuntimeTests;\n        phenix-repository-checks = phenixRepositoryChecks;",
    "        phenix-runtime-tests = phenixRuntimeTests;\n        phenix-typecheck = phenixTypecheck;\n        phenix-repository-checks = phenixRepositoryChecks;",
    1,
)
nix = nix.replace(
    "        phenix-runtime-tests = phenixRuntimeTests;\n        phenix-repository-checks = phenixRepositoryChecks;",
    "        phenix-runtime-tests = phenixRuntimeTests;\n        phenix-typecheck = phenixTypecheck;\n        phenix-repository-checks = phenixRepositoryChecks;",
    1,
)
nix_path.write_text(nix)

check_path = ROOT / "scripts/check.sh"
check = check_path.read_text()
old = '''    nix build --no-link \\
      .#phenix-runtime-tests \\
      .#phenix-repository-checks
'''
new = '''    nix build --no-link \\
      .#phenix-runtime-tests \\
      .#phenix-typecheck \\
      .#phenix-repository-checks
'''
if check.count(old) != 1:
    raise RuntimeError("could not locate staged check build")
check_path.write_text(check.replace(old, new, 1))
