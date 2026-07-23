from pathlib import Path

path = Path('.github/patch-graceful-recovery.py')
source = path.read_text()

old_tools = '''replace_once(
    executor_path,
    ''' + "'''      tools: [...new Set([...definition.tools.allow, \"phenix_return\"])],'''" + ''',
    ''' + "'''      tools: [...new Set([...compiled.tools, \"phenix_return\", \"phenix_fail\"])],'''" + ''',
)'''
new_tools = '''source = read(executor_path)
old = '      tools: [...new Set([...definition.tools.allow, "phenix_return"])],'
if source.count(old) < 1:
    raise SystemExit(f"{executor_path}: missing start tools occurrence")
write(
    executor_path,
    source.replace(
        old,
        '      tools: [...new Set([...compiled.tools, "phenix_return", "phenix_fail"])],',
        1,
    ),
)'''

old_attach = '''replace_once(
    executor_path,
    ''' + "'''    const live = this.attach(command.runId, definition, session);'''" + ''',
    ''' + "'''    const live = this.attach(command.runId, definition, compiled.limits, session);'''" + ''',
)'''
new_attach = '''source = read(executor_path)
old = '    const live = this.attach(command.runId, definition, session);'
if source.count(old) < 1:
    raise SystemExit(f"{executor_path}: missing start attach occurrence")
write(
    executor_path,
    source.replace(
        old,
        '    const live = this.attach(command.runId, definition, compiled.limits, session);',
        1,
    ),
)'''

if source.count(old_tools) != 1:
    raise SystemExit(f'expected one tools patch block, found {source.count(old_tools)}')
if source.count(old_attach) != 1:
    raise SystemExit(f'expected one attach patch block, found {source.count(old_attach)}')
source = source.replace(old_tools, new_tools).replace(old_attach, new_attach)
prompt_prefix = "    '''    return `${definition.prompt.render(input)}\\n\\nExecution protocol:"
raw_prompt_prefix = "    r'''    return `${definition.prompt.render(input)}\\n\\nExecution protocol:"
if source.count(prompt_prefix) != 2:
    raise SystemExit(f'expected two prompt literals, found {source.count(prompt_prefix)}')
path.write_text(source.replace(prompt_prefix, raw_prompt_prefix))
