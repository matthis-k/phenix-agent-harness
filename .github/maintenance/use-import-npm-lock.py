from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "modules/pi-packages.nix"
content = path.read_text()

content = content.replace("{ lib, ... }:\n", "{ ... }:\n", 1)

start = content.index("      piNpmPackageSpecs = {")
end = content.index("      phenixPiPackage =", start)
replacement = '''      piNpmRoot = ./pi-npm;

      # package-lock.json is the sole dependency authority. importNpmLock
      # resolves every registry or Git dependency from its recorded integrity
      # hash or commit without a repository-wide fixed-output hash.
      piNpmPackages = pkgs.importNpmLock.buildNodeModules {
        npmRoot = piNpmRoot;
        nodejs = pkgs.nodejs;
        derivationArgs = {
          pname = "phenix-pi-npm-packages";
          version = "1.0.0";
          npm_config_ignore_scripts = true;
        };
      };

'''
content = content[:start] + replacement + content[end:]

old_copy = '        cp -R ${piNpmPackages}/npm/node_modules "$out/node_modules"\n'
new_copy = '        cp -R ${piNpmPackages}/node_modules "$out/node_modules"\n'
if content.count(old_copy) != 1:
    raise RuntimeError("unexpected Pi npm node_modules copy path")
content = content.replace(old_copy, new_copy, 1)

app_start = content.index("      updatePiNpmHash =")
app_end = content.index("    in\n", app_start)
app = '''      updatePiNpmLock = pkgs.writeShellApplication {
        name = "update-pi-npm-lock";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          if [[ ! -f modules/pi-npm/package.json ]]; then
            echo "run this command from the phenix-agent-harness repository root" >&2
            exit 1
          fi

          npm install \\
            --prefix modules/pi-npm \\
            --package-lock-only \\
            --ignore-scripts \\
            --no-audit \\
            --no-fund

          echo "Updated modules/pi-npm/package-lock.json"
        '';
      };
'''
content = content[:app_start] + app + content[app_end:]

content = content.replace(
    "        update-pi-npm-hash = updatePiNpmHash;\n",
    "        update-pi-npm-lock = updatePiNpmLock;\n",
    1,
)

path.write_text(content)
