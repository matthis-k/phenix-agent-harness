use genai::resolver::AuthData;
use genai::ModelIden;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const CREDENTIAL_FILE_ENV: &str = "PHENIX_CREDENTIAL_FILE";

#[derive(Clone, Debug)]
pub(crate) struct CredentialStore {
    pub(crate) path: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredCredentials {
    providers: BTreeMap<String, StoredCredential>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum StoredCredential {
    ApiKey {
        secret: String,
    },
    OAuth {
        access_token: String,
        refresh_token: String,
        id_token: String,
        account_id: String,
        expires_at: u64,
    },
}

impl CredentialStore {
    pub(crate) fn discover() -> Result<Self, String> {
        if let Some(path) = std::env::var_os(CREDENTIAL_FILE_ENV) {
            return Ok(Self { path: path.into() });
        }
        let state = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            })
            .ok_or_else(|| {
                format!("set {CREDENTIAL_FILE_ENV}, XDG_STATE_HOME, or HOME for Phenix credentials")
            })?;
        Ok(Self {
            path: state.join("phenix/credentials.json"),
        })
    }

    pub(crate) fn resolve(&self, provider: &str) -> Result<Option<StoredCredential>, String> {
        let credentials = self.read()?;
        Ok(credentials.providers.get(provider).cloned())
    }

    pub(crate) fn save_oauth(
        &self,
        provider: &str,
        credential: StoredCredential,
    ) -> Result<(), String> {
        if !matches!(credential, StoredCredential::OAuth { .. }) {
            return Err("OAuth credential store received an API key".to_owned());
        }
        let mut credentials = self.read()?;
        credentials
            .providers
            .insert(provider.to_owned(), credential);
        self.write(&credentials)
    }

    pub(crate) fn auth_for_model(
        &self,
        model: ModelIden,
    ) -> Result<Option<AuthData>, genai::resolver::Error> {
        let provider = model.adapter_kind.as_lower_str();
        self.resolve(provider)
            .and_then(|credential| match credential {
                Some(StoredCredential::ApiKey { secret }) => {
                    Ok(Some(AuthData::from_single(secret)))
                }
                Some(StoredCredential::OAuth { .. }) => Err(format!(
                    "provider {provider:?} requires its dedicated OAuth adapter"
                )),
                None => Ok(None),
            })
            .map_err(genai::resolver::Error::Custom)
    }

    fn read(&self) -> Result<StoredCredentials, String> {
        match fs::read_to_string(&self.path) {
            Ok(source) => serde_json::from_str(&source)
                .map_err(|error| format!("cannot parse {}: {error}", self.path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(StoredCredentials::default())
            }
            Err(error) => Err(format!("cannot read {}: {error}", self.path.display())),
        }
    }

    fn write(&self, credentials: &StoredCredentials) -> Result<(), String> {
        let parent = self.path.parent().ok_or_else(|| {
            format!(
                "credential path {} has no parent directory",
                self.path.display()
            )
        })?;
        let parent_existed = parent.exists();
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        if !parent_existed {
            secure_directory(parent)?;
        }
        let temporary = self.path.with_extension("json.new");
        let source = serde_json::to_vec_pretty(credentials)
            .map_err(|error| format!("cannot encode credentials: {error}"))?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        secure_file_options(&mut options);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("cannot create {}: {error}", temporary.display()))?;
        secure_file(&temporary)?;
        file.write_all(&source)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &self.path)
            .map_err(|error| format!("cannot replace {}: {error}", self.path.display()))
    }
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("cannot secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
fn secure_file_options(_options: &mut OpenOptions) {}
