from pathlib import Path


def patch(path, old, new):
    p = Path(path)
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"anchor count {s.count(old)} in {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))

patch(
    "rust/crates/phenix-conductor/src/context.rs",
    "    UnknownSkill(SkillId),\n}",
    "    UnknownSkill(SkillId),\n    ManualOnlySkill(SkillId),\n}",
)
patch(
    "rust/crates/phenix-conductor/src/context.rs",
    "            Self::UnknownSkill(id) => write!(f, \"unknown skill: {id}\"),\n",
    "            Self::UnknownSkill(id) => write!(f, \"unknown skill: {id}\"),\n            Self::ManualOnlySkill(id) => write!(f, \"skill is manual-only: {id}\"),\n",
)
patch(
    "rust/crates/phenix-conductor/src/context.rs",
    "    pub fn skill_payload(&self, id: &SkillId) -> Result<String, ContextError> {\n        self.skills\n            .get(id)\n            .map(render_skill)\n            .ok_or_else(|| ContextError::UnknownSkill(id.clone()))\n    }\n",
    "    pub fn model_skill_payload(&self, id: &SkillId) -> Result<String, ContextError> {\n        let skill = self\n            .skills\n            .get(id)\n            .ok_or_else(|| ContextError::UnknownSkill(id.clone()))?;\n        if skill.descriptor.invocation != SkillInvocationPolicy::ModelEligible {\n            return Err(ContextError::ManualOnlySkill(id.clone()));\n        }\n        Ok(render_skill(skill))\n    }\n",
)
patch(
    "rust/crates/phenix-conductor/src/context.rs",
    "        let payload = registry\n            .skill_payload(&SkillId::parse(\"unslop\").unwrap())\n            .unwrap();\n        assert!(payload.contains(\"Remove generic AI patterns\"));\n        assert!(payload.contains(\"root=\\\"\"));\n",
    "        let payload = registry\n            .model_skill_payload(&SkillId::parse(\"unslop\").unwrap())\n            .unwrap();\n        assert!(payload.contains(\"Remove generic AI patterns\"));\n        assert!(payload.contains(\"root=\\\"\"));\n        assert!(matches!(\n            registry.model_skill_payload(&SkillId::parse(\"tdd\").unwrap()),\n            Err(ContextError::ManualOnlySkill(_))\n        ));\n",
)
patch(
    "rust/crates/phenix-conductor/src/lib.rs",
    "        Ok(self.context.skill_payload(id)?)\n",
    "        Ok(self.context.model_skill_payload(id)?)\n",
)
patch(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "pub(super) fn extend_root_workflow_tools(\n",
    "pub(super) fn extend_semantic_tools(\n",
)
patch(
    "rust/crates/phenix-conductor/src/server.rs",
    "            semantic_tools::extend_root_workflow_tools(&runtime_guard, resolved);\n",
    "            semantic_tools::extend_semantic_tools(&runtime_guard, resolved);\n",
)

readme = Path("README.md")
text = readme.read_text()
anchor = "The conductor is mechanism, not policy. It validates and executes supplied backends, routing tables, workflows, and tool policy; it does not silently install preferred models, roles, or workflows.\n"
addition = r'''

### Project context and skills

The conductor loads project context and skills as separate mechanisms for the working directory supplied with `--cwd`.

Project context is ambient instruction material. At startup the conductor resolves the repository root, loads `AGENTS.override.md` or `AGENTS.md` from the root through the selected working directory, and also loads root `CONTRIBUTING.md` and `DEVELOPMENT.md` when present. The resulting snapshot is frozen into the running conductor process rather than reread during a turn.

Skills use the `SKILL.md` directory convention. Portable `.agents/skills`, Phenix `.phenix/skills` / `~/.config/phenix/skills`, and Cursor/Claude/Codex compatibility roots are discovered with project-local definitions taking precedence over user definitions. `PHENIX_SKILL_PATH` can add explicit roots. The conductor exposes only skill name and description to models until `phenix_skill_load` is called. `disable-model-invocation: true` is normalized as a manual-only policy and is enforced by the loader, while the complete catalog remains available to frontends through `get_skill_catalog`. A user can activate any known skill explicitly for one turn with `/skill <name> ...` or `/<name> ...`.

Skill `allowed-tools` metadata is advisory only and never expands conductor tool permissions. Skill resources under `scripts/`, `references/`, and `assets/` are inventoried relative to the skill root; executing scripts remains subject to the ordinary workspace/tool permission model.
'''
if text.count(anchor) != 1:
    raise SystemExit("README anchor missing")
readme.write_text(text.replace(anchor, anchor + addition, 1))
