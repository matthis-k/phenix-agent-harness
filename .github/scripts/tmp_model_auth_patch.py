from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, source):
    Path(path).write_text(source)


def one_replace(source, old, new, label):
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return source.replace(old, new, 1)


path = "rust/crates/phenix-core/src/lib.rs"
source = read(path)
source = one_replace(
    source,
    "pub struct ModelDescriptor {\n    pub target: ModelTarget,\n    pub name: String,\n}\n",
    "pub struct ModelDescriptor {\n    pub target: ModelTarget,\n    pub name: String,\n    pub selectable: bool,\n}\n",
    "core ModelDescriptor",
)
write(path, source)

path = "rust/crates/phenix-backend-native/src/lib.rs"
source = read(path)
source = one_replace(
    source,
    """        let models = selectable_models(&self.credentials, &self.models)?
            .into_iter()
            .map(|selection| {
                Ok(ModelDescriptor {
                    target: selection.target()?,
                    name: selection.wire_value(),
                })
            })
            .collect::<Result<Vec<_>, BackendError>>()?;
""",
    """        let models = self
            .models
            .iter()
            .map(|selection| model_descriptor(&self.credentials, selection))
            .collect::<Result<Vec<_>, BackendError>>()?;
""",
    "native catalog models",
)
source = one_replace(
    source,
    """fn selectable_models<'a>(
    credentials: &CredentialStore,
    models: &'a [ModelSelection],
) -> Result<Vec<&'a ModelSelection>, BackendError> {
    let mut selectable = Vec::new();
    for selection in models {
        if provider_has_valid_auth(credentials, &selection.provider)? {
            selectable.push(selection);
        }
    }
    Ok(selectable)
}

""",
    """fn model_descriptor(
    credentials: &CredentialStore,
    selection: &ModelSelection,
) -> Result<ModelDescriptor, BackendError> {
    Ok(ModelDescriptor {
        target: selection.target()?,
        name: selection.wire_value(),
        selectable: provider_has_valid_auth(credentials, &selection.provider)?,
    })
}

""",
    "native selectable helper",
)
start_marker = "    #[test]\n    fn model_catalog_only_exposes_authenticated_providers() {"
end_marker = "\n\n    #[test]\n    fn model_identity_preserves_provider_and_model() {"
start = source.find(start_marker)
end = source.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("native auth model test markers not found")
new_test = """    #[test]
    fn model_catalog_marks_provider_auth_selectability() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "phenix-model-auth-test-{}-{unique}",
            std::process::id()
        ));
        let credentials = CredentialStore {
            path: root.join("credentials.json"),
        };
        let codex = ModelSelection::parse("openai-codex/gpt-test").unwrap();
        let local = ModelSelection::parse("ollama/local-test").unwrap();

        assert!(!model_descriptor(&credentials, &codex).unwrap().selectable);
        assert!(model_descriptor(&credentials, &local).unwrap().selectable);

        credentials
            .save_oauth(
                oauth::PROVIDER,
                StoredCredential::OAuth {
                    access_token: "access".to_owned(),
                    refresh_token: "refresh".to_owned(),
                    id_token: "id".to_owned(),
                    account_id: "account".to_owned(),
                    expires_at: u64::MAX,
                },
            )
            .unwrap();
        assert!(model_descriptor(&credentials, &codex).unwrap().selectable);
        let _ = fs::remove_dir_all(root);
    }"""
source = source[:start] + new_test + source[end:]
write(path, source)

path = "rust/crates/phenix-backend-acp/src/lib.rs"
source = read(path)
source = one_replace(
    source,
    """            Ok(ModelDescriptor {
                target: ModelTarget {
                    backend: backend.clone(),
                    provider: provider.clone(),
                    model,
                    inference: InferenceOptions::default(),
                },
                name,
            })
""",
    """            Ok(ModelDescriptor {
                target: ModelTarget {
                    backend: backend.clone(),
                    provider: provider.clone(),
                    model,
                    inference: InferenceOptions::default(),
                },
                name,
                selectable: true,
            })
""",
    "ACP ModelDescriptor",
)
write(path, source)

replacements = {
    "rust/crates/phenix-conductor/tests/support/protocol_harness.rs": (
        '                name: "Mock Model".to_owned(),\n            }],',
        '                name: "Mock Model".to_owned(),\n                selectable: true,\n            }],',
    ),
    "rust/crates/phenix-conductor/tests/support/server_cancellation.rs": (
        '                name: "Fixture Model".to_owned(),\n            }],',
        '                name: "Fixture Model".to_owned(),\n                selectable: true,\n            }],',
    ),
    "rust/crates/phenix-conductor/tests/stdio_roundtrip.rs": (
        '                name: "Mock Model".to_owned(),\n            }],',
        '                name: "Mock Model".to_owned(),\n                selectable: true,\n            }],',
    ),
}
for path, (old, new) in replacements.items():
    source = read(path)
    source = one_replace(source, old, new, path)
    write(path, source)

path = "rust/crates/phenix-conductor/tests/support/protocol_public_journeys.rs"
source = read(path)
source = one_replace(
    source,
    """                ModelDescriptor {
                    target: auth_model("alpha"),
                    name: "Alpha".to_owned(),
                },
                ModelDescriptor {
                    target: auth_model("beta"),
                    name: "Beta".to_owned(),
                },
""",
    """                ModelDescriptor {
                    target: auth_model("alpha"),
                    name: "Alpha".to_owned(),
                    selectable: true,
                },
                ModelDescriptor {
                    target: auth_model("beta"),
                    name: "Beta".to_owned(),
                    selectable: true,
                },
""",
    "public journeys descriptors",
)
write(path, source)
