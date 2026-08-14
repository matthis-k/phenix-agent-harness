use crate::credentials::{CredentialStore, StoredCredential};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use genai::resolver::AuthData;
use genai::Headers;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

const PROVIDER: &str = "openai-codex";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REFRESH_MARGIN_SECONDS: u64 = 5 * 60;

#[derive(Clone)]
pub(crate) struct CodexOAuth {
    store: CredentialStore,
    refresh_lock: Arc<Mutex<()>>,
}

impl CodexOAuth {
    pub(crate) fn new(store: CredentialStore) -> Self {
        Self {
            store,
            refresh_lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) async fn auth_data(&self) -> Result<Option<AuthData>, String> {
        let _guard = self.refresh_lock.lock().await;
        let Some(credential) = self.store.resolve(PROVIDER)? else {
            return Ok(None);
        };
        let credential = match credential {
            StoredCredential::OAuth { expires_at, .. }
                if expires_at <= unix_time()?.saturating_add(REFRESH_MARGIN_SECONDS) =>
            {
                refresh(&self.store, credential).await?
            }
            StoredCredential::OAuth { .. } => credential,
            StoredCredential::ApiKey { .. } => {
                return Err("openai-codex requires ChatGPT OAuth, not an API key".to_owned());
            }
        };
        let StoredCredential::OAuth {
            access_token,
            account_id,
            ..
        } = credential
        else {
            unreachable!("credential variant checked above")
        };
        Ok(Some(AuthData::RequestOverride {
            url: RESPONSES_URL.to_owned(),
            headers: Headers::from([
                ("Authorization", format!("Bearer {access_token}")),
                ("ChatGPT-Account-ID", account_id),
                ("originator", "phenix".to_owned()),
                ("version", env!("CARGO_PKG_VERSION").to_owned()),
            ]),
        }))
    }
}

pub(crate) async fn login(store: &CredentialStore) -> Result<(), String> {
    let listener = match TcpListener::bind(("127.0.0.1", 1455)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("127.0.0.1", 1457))
            .await
            .map_err(|error| {
                format!("cannot bind OAuth callback on ports 1455 or 1457: {error}")
            })?,
    };
    let port = listener
        .local_addr()
        .map_err(|error| format!("cannot inspect OAuth callback address: {error}"))?
        .port();
    let redirect_uri = format!("http://localhost:{port}/auth/callback");
    let verifier = random_urlsafe(64)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_urlsafe(32)?;
    let authorization_url = authorization_url(&redirect_uri, &challenge, &state)?;

    println!("Sign in with ChatGPT to authorize Phenix:\n\n{authorization_url}\n");
    println!("Waiting for the verified OAuth callback on localhost:{port} …");

    let result = tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener, &state)).await;
    let code = match result {
        Ok(result) => result?,
        Err(_) => return Err("OAuth login timed out after 10 minutes".to_owned()),
    };
    let tokens = exchange_code(&code, &redirect_uri, &verifier).await?;
    let credential = credential_from_tokens(tokens)?;
    store.save_oauth(PROVIDER, credential)?;
    println!("Authenticated openai-codex with ChatGPT.");
    Ok(())
}

fn authorization_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<String, String> {
    let mut url = Url::parse(&format!("{ISSUER}/oauth/authorize"))
        .map_err(|error| format!("invalid OAuth issuer: {error}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair(
            "scope",
            "openid profile email offline_access api.connectors.read api.connectors.invoke",
        )
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", "phenix");
    Ok(url.into())
}

async fn receive_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|error| format!("OAuth callback failed: {error}"))?;
    let mut request = vec![0_u8; 16 * 1024];
    let length = stream
        .read(&mut request)
        .await
        .map_err(|error| format!("cannot read OAuth callback: {error}"))?;
    let request = std::str::from_utf8(&request[..length])
        .map_err(|_| "OAuth callback was not valid HTTP".to_owned())?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "OAuth callback did not contain a request target".to_owned())?;
    let url = Url::parse(&format!("http://localhost{target}"))
        .map_err(|error| format!("invalid OAuth callback URL: {error}"))?;
    let query = url
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    let result = if let Some(error) = query.get("error") {
        Err(format!("OAuth authorization was rejected: {error}"))
    } else if query.get("state").map(|value| value.as_ref()) != Some(expected_state) {
        Err("OAuth callback state verification failed".to_owned())
    } else {
        query
            .get("code")
            .map(|value| value.to_string())
            .ok_or_else(|| "OAuth callback did not contain an authorization code".to_owned())
    };
    let (status, body) = if result.is_ok() {
        (
            "200 OK",
            "Phenix authentication completed. You may close this tab.",
        )
    } else {
        (
            "400 Bad Request",
            "Phenix authentication failed. Return to Neovim for details.",
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    result
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: String,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<TokenResponse, String> {
    post_token_form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ])
    .await
}

async fn refresh(
    store: &CredentialStore,
    credential: StoredCredential,
) -> Result<StoredCredential, String> {
    let StoredCredential::OAuth {
        access_token,
        refresh_token,
        id_token,
        account_id,
        ..
    } = credential
    else {
        return Err("cannot refresh a non-OAuth credential".to_owned());
    };
    let response: RefreshResponse = post_token_form(&[
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", &refresh_token),
    ])
    .await?;
    let access_token = response.access_token.unwrap_or(access_token);
    let refresh_token = response.refresh_token.unwrap_or(refresh_token);
    let id_token = response.id_token.unwrap_or(id_token);
    let account_id = account_id_from_token(&id_token)
        .or_else(|| account_id_from_token(&access_token))
        .unwrap_or(account_id);
    let expires_at = token_expiry(&access_token).unwrap_or(unix_time()?.saturating_add(3600));
    let refreshed = StoredCredential::OAuth {
        access_token,
        refresh_token,
        id_token,
        account_id,
        expires_at,
    };
    store.save_oauth(PROVIDER, refreshed.clone())?;
    Ok(refreshed)
}

async fn post_token_form<T: for<'de> Deserialize<'de>>(form: &[(&str, &str)]) -> Result<T, String> {
    let response = Client::new()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|error| format!("OAuth token request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "unreadable response".to_owned());
        return Err(format!("OAuth token endpoint returned {status}: {message}"));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid OAuth token response: {error}"))
}

fn credential_from_tokens(tokens: TokenResponse) -> Result<StoredCredential, String> {
    let account_id = account_id_from_token(&tokens.id_token)
        .or_else(|| account_id_from_token(&tokens.access_token))
        .ok_or_else(|| "OAuth token does not identify a ChatGPT account".to_owned())?;
    let expires_at =
        token_expiry(&tokens.access_token).unwrap_or(unix_time()?.saturating_add(3600));
    Ok(StoredCredential::OAuth {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        account_id,
        expires_at,
    })
}

fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn token_expiry(token: &str) -> Option<u64> {
    jwt_payload(token)?.get("exp")?.as_u64()
}

fn account_id_from_token(token: &str) -> Option<String> {
    let claims = jwt_payload(token)?;
    claims
        .get("chatgpt_account_id")
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| auth.get("chatgpt_account_id"))
        })?
        .as_str()
        .map(ToOwned::to_owned)
}

fn random_urlsafe(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| format!("cannot generate OAuth secret: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn unix_time() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("system clock predates Unix epoch: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_uses_pkce_and_callback_state() {
        let url = authorization_url("http://localhost:1455/auth/callback", "challenge", "state")
            .expect("authorization URL");
        let url = Url::parse(&url).expect("valid URL");
        let query = url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            query.get("code_challenge_method").map(|v| v.as_ref()),
            Some("S256")
        );
        assert_eq!(query.get("state").map(|v| v.as_ref()), Some("state"));
        assert_eq!(
            query.get("redirect_uri").map(|v| v.as_ref()),
            Some("http://localhost:1455/auth/callback")
        );
    }

    #[test]
    fn extracts_nested_chatgpt_account_and_expiry() {
        let payload = URL_SAFE_NO_PAD.encode(
            br#"{"exp":42,"https://api.openai.com/auth":{"chatgpt_account_id":"account-1"}}"#,
        );
        let token = format!("header.{payload}.signature");
        assert_eq!(token_expiry(&token), Some(42));
        assert_eq!(account_id_from_token(&token).as_deref(), Some("account-1"));
    }

    #[tokio::test]
    async fn projects_stored_oauth_into_the_chatgpt_codex_request() {
        let directory = std::env::temp_dir().join(format!(
            "phenix-runtime-oauth-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let store = CredentialStore {
            path: directory.join("credentials.json"),
        };
        store
            .save_oauth(
                PROVIDER,
                StoredCredential::OAuth {
                    access_token: "access-token".to_owned(),
                    refresh_token: "refresh-token".to_owned(),
                    id_token: "id-token".to_owned(),
                    account_id: "account-1".to_owned(),
                    expires_at: unix_time().expect("clock") + 3600,
                },
            )
            .expect("save OAuth");

        let auth = CodexOAuth::new(store.clone())
            .auth_data()
            .await
            .expect("resolve OAuth")
            .expect("OAuth credential");
        let AuthData::RequestOverride { url, headers } = auth else {
            panic!("OAuth must override the request endpoint and headers");
        };
        assert_eq!(url, RESPONSES_URL);
        assert!(headers
            .iter()
            .any(|(name, value)| { name == "Authorization" && value == "Bearer access-token" }));
        assert!(headers
            .iter()
            .any(|(name, value)| { name == "ChatGPT-Account-ID" && value == "account-1" }));

        let _ = std::fs::remove_file(directory.join("credentials.json"));
        let _ = std::fs::remove_dir(directory);
    }
}
