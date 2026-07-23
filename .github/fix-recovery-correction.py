from pathlib import Path

path = Path('.github/correct-graceful-recovery.py')
source = path.read_text()
old = '    source = replace_exact(source, command_provider_old, command_provider_new, expected=2)\n'
new = '''    source = replace_exact(source, command_provider_old, command_provider_new)
    source = replace_exact(
        source,
        command_provider_old.replace("        await", "      await").replace(
            "          code", "        code"
        ).replace("          message", "        message").replace(
            "          retryable", "        retryable"
        ).replace("        });", "      });"),
        command_provider_new.replace("        await", "      await").replace(
            "          command", "        command"
        ).replace("          automaticFailure", "        automaticFailure").replace(
            "            ", "          "
        ).replace("          ),", "        ),").replace("        );", "      );"),
    )
'''
if old not in source:
    if 'expected=2' not in source:
        raise SystemExit('provider correction already split')
    raise SystemExit('provider correction line not found')
path.write_text(source.replace(old, new))
