use crate::credentials::{CredentialStore, StoredCredential};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use genai::resolver::AuthData;
use genai::Headers;
use oauth2::basic::{
    BasicErrorResponse, BasicRevocationErrorResponse, BasicTokenIntrospectionResponse,
    BasicTokenType,
};
use oauth2::{
    AccessToken, AsyncHttpClient, AuthUrl, AuthorizationCode, Client as OAuthClient, ClientId,
    CsrfToken, EndpointNotSet, EndpointSet, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    RefreshToken, RequestTokenError, Scope, StandardRevocableToken, TokenResponse, TokenUrl,
};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

pub(crate) const PROVIDER: &str = "openai-codex";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REFRESH_MARGIN_SECONDS: u64 = 5 * 60;

type CodexOAuthClient = OAuthClient<
    BasicErrorResponse,
    CodexTokenResponse,
    BasicTokenIntrospectionResponse,
    StandardRevocableToken,
    BasicRevocationErrorResponse,
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
>;

type CodexTokenRequestError = RequestTokenError<OAuthHttpError, BasicErrorResponse>;

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
    let client = oauth_client(Some(&redirect_uri))?;
    let http_client = OAuthHttpClient::new()?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (authorization_url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("openid".to_owned()))
        .add_scope(Scope::new("profile".to_owned()))
        .add_scope(Scope::new("email".to_owned()))
        .add_scope(Scope::new("offline_access".to_owned()))
        .add_scope(Scope::new("api.connectors.read".to_owned()))
        .add_scope(Scope::new("api.connectors.invoke".to_owned()))
        .set_pkce_challenge(challenge)
        .add_extra_param("id_token_add_organizations", "true")
        .add_extra_param("codex_cli_simplified_flow", "true")
        .add_extra_param("originator", "phenix")
        .url();

    eprintln!("Sign in with ChatGPT to authorize Phenix:\n\n{authorization_url}\n");
    eprintln!("Waiting for the verified OAuth callback on localhost:{port} …");

    let result = tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener, &state)).await;
    let code = match result {
        Ok(result) => result?,
        Err(_) => return Err("OAuth login timed out after 10 minutes".to_owned()),
    };
    let tokens = client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(verifier)
        .request_async(&http_client)
        .await
        .map_err(token_request_error)?;
    let credential = credential_from_tokens(tokens)?;
    store.save_oauth(PROVIDER, credential)?;
    Ok(())
}

async fn receive_callback(
    listener: TcpListener,
    expected_state: &CsrfToken,
) -> Result<String, String> {
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
    } else if query
        .get("state")
        .map(|value| CsrfToken::new(value.to_string()))
        .as_ref()
        != Some(expected_state)
    {
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

#[derive(Debug, Deserialize, Serialize)]
struct CodexTokenResponse {
    access_token: AccessToken,
    #[serde(default)]
    refresh_token: Option<RefreshToken>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default = "bearer_token_type", skip_serializing)]
    token_type: BasicTokenType,
}

impl TokenResponse for CodexTokenResponse {
    type TokenType = BasicTokenType;

    fn access_token(&self) -> &AccessToken {
        &self.access_token
    }

    fn token_type(&self) -> &Self::TokenType {
        &self.token_type
    }

    fn expires_in(&self) -> Option<Duration> {
        self.expires_in.map(Duration::from_secs)
    }

    fn refresh_token(&self) -> Option<&RefreshToken> {
        self.refresh_token.as_ref()
    }

    fn scopes(&self) -> Option<&Vec<Scope>> {
        None
    }
}

fn bearer_token_type() -> BasicTokenType {
    BasicTokenType::Bearer
}

async fn refresh(
    store: &CredentialStore,
    credential: StoredCredential,
) -> Result<StoredCredential, String> {
    let StoredCredential::OAuth {
        refresh_token,
        id_token,
        account_id,
        ..
    } = credential
    else {
        return Err("cannot refresh a non-OAuth credential".to_owned());
    };
    let client = oauth_client(None)?;
    let http_client = OAuthHttpClient::new()?;
    let refresh_token_request = RefreshToken::new(refresh_token.clone());
    let response = client
        .exchange_refresh_token(&refresh_token_request)
        .request_async(&http_client)
        .await
        .map_err(token_request_error)?;
    let access_token = response.access_token().secret().to_owned();
    let refresh_token = response
        .refresh_token()
        .map(|token| token.secret().to_owned())
        .unwrap_or(refresh_token);
    let id_token = response.id_token.unwrap_or(id_token);
    let account_id = account_id_from_token(&id_token)
        .or_else(|| account_id_from_token(&access_token))
        .unwrap_or(account_id);
    let expires_at = response_expiry(&response, &access_token)?;
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

fn oauth_client(redirect_uri: Option<&str>) -> Result<CodexOAuthClient, String> {
    let client = OAuthClient::<
        BasicErrorResponse,
        CodexTokenResponse,
        BasicTokenIntrospectionResponse,
        StandardRevocableToken,
        BasicRevocationErrorResponse,
    >::new(ClientId::new(CLIENT_ID.to_owned()))
    .set_auth_uri(
        AuthUrl::new(AUTH_URL.to_owned())
            .map_err(|error| format!("invalid OAuth authorization URL: {error}"))?,
    )
    .set_token_uri(
        TokenUrl::new(TOKEN_URL.to_owned())
            .map_err(|error| format!("invalid OAuth token URL: {error}"))?,
    );
    match redirect_uri {
        Some(redirect_uri) => Ok(client.set_redirect_uri(
            RedirectUrl::new(redirect_uri.to_owned())
                .map_err(|error| format!("invalid OAuth redirect URL: {error}"))?,
        )),
        None => Ok(client),
    }
}

fn credential_from_tokens(tokens: CodexTokenResponse) -> Result<StoredCredential, String> {
    let access_token = tokens.access_token().secret().to_owned();
    let refresh_token = tokens
        .refresh_token()
        .map(|token| token.secret().to_owned())
        .ok_or_else(|| "OAuth token response did not include a refresh token".to_owned())?;
    let id_token = tokens
        .id_token
        .clone()
        .ok_or_else(|| "OAuth token response did not include an ID token".to_owned())?;
    let account_id = account_id_from_token(&id_token)
        .or_else(|| account_id_from_token(&access_token))
        .ok_or_else(|| "OAuth token does not identify a ChatGPT account".to_owned())?;
    let expires_at = response_expiry(&tokens, &access_token)?;
    Ok(StoredCredential::OAuth {
        access_token,
        refresh_token,
        id_token,
        account_id,
        expires_at,
    })
}

fn response_expiry(tokens: &CodexTokenResponse, access_token: &str) -> Result<u64, String> {
    let now = unix_time()?;
    Ok(token_expiry(access_token)
        .or_else(|| {
            tokens
                .expires_in()
                .map(|duration| now.saturating_add(duration.as_secs()))
        })
        .unwrap_or_else(|| now.saturating_add(3600)))
}

fn token_request_error(error: CodexTokenRequestError) -> String {
    match error {
        RequestTokenError::ServerResponse(error) => {
            format!("OAuth token endpoint rejected request: {error}")
        }
        RequestTokenError::Request(error) => format!("OAuth token request failed: {error}"),
        RequestTokenError::Parse(error, body) => format!(
            "invalid OAuth token response: {error}: {}",
            String::from_utf8_lossy(&body)
        ),
        RequestTokenError::Other(error) => format!("OAuth token request failed: {error}"),
    }
}

#[derive(Clone)]
struct OAuthHttpClient {
    client: reqwest::Client,
}

impl OAuthHttpClient {
    fn new() -> Result<Self, String> {
        reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .map(|client| Self { client })
            .map_err(|error| format!("cannot build OAuth HTTP client: {error}"))
    }
}

#[derive(Debug, Error)]
enum OAuthHttpError {
    #[error(transparent)]
    Request(#[from] reqwest::Error),
    #[error(transparent)]
    Response(#[from] oauth2::http::Error),
}

impl<'c> AsyncHttpClient<'c> for OAuthHttpClient {
    type Error = OAuthHttpError;
    type Future = Pin<Box<dyn Future<Output = Result<oauth2::HttpResponse, Self::Error>> + 'c>>;

    fn call(&'c self, request: oauth2::HttpRequest) -> Self::Future {
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let response = self
                .client
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(body)
                .send()
                .await?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = response.bytes().await?.to_vec();
            let mut response = oauth2::HttpResponse::builder().status(status).body(body)?;
            *response.headers_mut() = headers;
            Ok(response)
        })
    }
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
    fn codex_token_response_accepts_missing_token_type() {
        let response: CodexTokenResponse = serde_json::from_value(serde_json::json!({
            "access_token": "access",
            "refresh_token": "refresh",
            "id_token": "id"
        }))
        .unwrap();
        assert!(matches!(response.token_type(), BasicTokenType::Bearer));
    }
}
