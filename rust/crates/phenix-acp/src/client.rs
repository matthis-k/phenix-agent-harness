use crate::{AcpMethod, IdError, RpcRequestId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub trait AcpTransport {
    type Error: Error + Send + Sync + 'static;

    fn exchange(&mut self, request: &[u8]) -> Result<Vec<u8>, Self::Error>;
}

pub struct AcpClient<T> {
    transport: T,
    next_request_id: u64,
}

impl<T> AcpClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_request_id: 1,
        }
    }

    pub fn into_transport(self) -> T {
        self.transport
    }
}

impl<T: AcpTransport> AcpClient<T> {
    pub fn call<M: AcpMethod>(
        &mut self,
        params: &M::Params,
    ) -> Result<M::Result, CallError<T::Error>> {
        let request_id = self.allocate_request_id()?;
        let request = RequestEnvelope {
            jsonrpc: "2.0",
            id: &request_id,
            method: M::METHOD,
            params,
        };
        let request = serde_json::to_vec(&request).map_err(CallError::EncodeRequest)?;
        let response = self
            .transport
            .exchange(&request)
            .map_err(CallError::Transport)?;
        decode_response::<M::Result>(&request_id, &response)
    }

    fn allocate_request_id(&mut self) -> Result<RpcRequestId, CallError<T::Error>> {
        let sequence = self.next_request_id;
        self.next_request_id = sequence
            .checked_add(1)
            .ok_or(CallError::RequestIdExhausted)?;
        RpcRequestId::parse(sequence.to_string())
            .map_err(|error| CallError::InvalidGeneratedRequestId(error.to_string()))
    }
}

#[derive(Serialize)]
struct RequestEnvelope<'a, P> {
    jsonrpc: &'static str,
    id: &'a RpcRequestId,
    method: &'static str,
    params: &'a P,
}

#[derive(Deserialize)]
struct ResponseEnvelope {
    jsonrpc: String,
    id: RpcRequestId,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RemoteError>,
}

fn decode_response<R: serde::de::DeserializeOwned, E>(
    expected_id: &RpcRequestId,
    response: &[u8],
) -> Result<R, CallError<E>> {
    let response: ResponseEnvelope =
        serde_json::from_slice(response).map_err(CallError::DecodeEnvelope)?;
    if response.jsonrpc != "2.0" {
        return Err(CallError::InvalidEnvelope(
            EnvelopeError::UnsupportedJsonRpcVersion(response.jsonrpc),
        ));
    }
    if &response.id != expected_id {
        return Err(CallError::InvalidEnvelope(EnvelopeError::MismatchedId {
            expected: expected_id.clone(),
            actual: response.id,
        }));
    }
    match (response.result, response.error) {
        (Some(result), None) => {
            serde_json::from_value(result).map_err(CallError::DecodeResult)
        }
        (None, Some(error)) => Err(CallError::Remote(error)),
        (Some(_), Some(_)) => Err(CallError::InvalidEnvelope(
            EnvelopeError::ResultAndErrorPresent,
        )),
        (None, None) => Err(CallError::InvalidEnvelope(
            EnvelopeError::ResultAndErrorMissing,
        )),
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RemoteError {
    pub code: i64,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvelopeError {
    UnsupportedJsonRpcVersion(String),
    MismatchedId {
        expected: RpcRequestId,
        actual: RpcRequestId,
    },
    ResultAndErrorPresent,
    ResultAndErrorMissing,
}

impl Display for EnvelopeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedJsonRpcVersion(version) => {
                write!(formatter, "unsupported JSON-RPC version {version}")
            }
            Self::MismatchedId { expected, actual } => {
                write!(formatter, "response ID {actual} does not match request ID {expected}")
            }
            Self::ResultAndErrorPresent => {
                formatter.write_str("JSON-RPC response contains both result and error")
            }
            Self::ResultAndErrorMissing => {
                formatter.write_str("JSON-RPC response contains neither result nor error")
            }
        }
    }
}

impl Error for EnvelopeError {}

#[derive(Debug)]
pub enum CallError<E> {
    RequestIdExhausted,
    InvalidGeneratedRequestId(String),
    EncodeRequest(serde_json::Error),
    Transport(E),
    DecodeEnvelope(serde_json::Error),
    InvalidEnvelope(EnvelopeError),
    DecodeResult(serde_json::Error),
    Remote(RemoteError),
}

impl<E: Display> Display for CallError<E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestIdExhausted => formatter.write_str("ACP request IDs are exhausted"),
            Self::InvalidGeneratedRequestId(message) => {
                write!(formatter, "generated invalid ACP request ID: {message}")
            }
            Self::EncodeRequest(error) => write!(formatter, "failed to encode ACP request: {error}"),
            Self::Transport(error) => write!(formatter, "ACP transport failed: {error}"),
            Self::DecodeEnvelope(error) => {
                write!(formatter, "failed to decode ACP response envelope: {error}")
            }
            Self::InvalidEnvelope(error) => write!(formatter, "invalid ACP response: {error}"),
            Self::DecodeResult(error) => {
                write!(formatter, "failed to decode typed ACP result: {error}")
            }
            Self::Remote(error) => write!(
                formatter,
                "ACP peer returned error {}: {}",
                error.code, error.message
            ),
        }
    }
}

impl<E> Error for CallError<E>
where
    E: Error + 'static,
{
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::EncodeRequest(error)
            | Self::DecodeEnvelope(error)
            | Self::DecodeResult(error) => Some(error),
            Self::Transport(error) => Some(error),
            Self::InvalidEnvelope(error) => Some(error),
            Self::RequestIdExhausted
            | Self::InvalidGeneratedRequestId(_)
            | Self::Remote(_) => None,
        }
    }
}

impl From<IdError> for EnvelopeError {
    fn from(error: IdError) -> Self {
        Self::UnsupportedJsonRpcVersion(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AcpMethod, SessionTreeId};
    use serde::{Deserialize, Serialize};
    use std::collections::VecDeque;
    use std::io;

    struct EchoMethod;

    impl AcpMethod for EchoMethod {
        const METHOD: &'static str = "_phenix/test/echo";
        type Params = EchoParams;
        type Result = EchoResult;
    }

    #[derive(Serialize)]
    struct EchoParams {
        value: String,
    }

    #[derive(Debug, Deserialize, Eq, PartialEq)]
    struct EchoResult {
        tree_id: SessionTreeId,
    }

    struct ScriptedTransport {
        responses: VecDeque<Result<Vec<u8>, io::Error>>,
        requests: Vec<Vec<u8>>,
    }

    impl ScriptedTransport {
        fn new(response: &[u8]) -> Self {
            Self {
                responses: VecDeque::from([Ok(response.to_vec())]),
                requests: Vec::new(),
            }
        }
    }

    impl AcpTransport for ScriptedTransport {
        type Error = io::Error;

        fn exchange(&mut self, request: &[u8]) -> Result<Vec<u8>, Self::Error> {
            self.requests.push(request.to_vec());
            self.responses
                .pop_front()
                .expect("scripted response must exist")
        }
    }

    #[test]
    fn method_type_links_params_to_the_only_valid_result_type() {
        let transport = ScriptedTransport::new(
            br#"{"jsonrpc":"2.0","id":"1","result":{"tree_id":"tree-1"}}"#,
        );
        let mut client = AcpClient::new(transport);
        let result = client
            .call::<EchoMethod>(&EchoParams {
                value: "hello".to_owned(),
            })
            .expect("typed call");
        assert_eq!(result.tree_id.as_str(), "tree-1");

        let transport = client.into_transport();
        let request: Value = serde_json::from_slice(&transport.requests[0]).expect("request JSON");
        assert_eq!(request["method"], EchoMethod::METHOD);
        assert_eq!(request["params"]["value"], "hello");
    }

    #[test]
    fn malformed_result_is_not_collapsed_into_a_transport_or_remote_error() {
        let transport = ScriptedTransport::new(
            br#"{"jsonrpc":"2.0","id":"1","result":{"tree_id":7}}"#,
        );
        let mut client = AcpClient::new(transport);
        assert!(matches!(
            client.call::<EchoMethod>(&EchoParams {
                value: "hello".to_owned(),
            }),
            Err(CallError::DecodeResult(_))
        ));
    }

    #[test]
    fn remote_errors_and_correlation_errors_remain_distinct() {
        let transport = ScriptedTransport::new(
            br#"{"jsonrpc":"2.0","id":"1","error":{"code":-32601,"message":"missing"}}"#,
        );
        let mut client = AcpClient::new(transport);
        assert!(matches!(
            client.call::<EchoMethod>(&EchoParams {
                value: "hello".to_owned(),
            }),
            Err(CallError::Remote(RemoteError { code: -32601, .. }))
        ));

        let transport = ScriptedTransport::new(
            br#"{"jsonrpc":"2.0","id":"other","result":{"tree_id":"tree-1"}}"#,
        );
        let mut client = AcpClient::new(transport);
        assert!(matches!(
            client.call::<EchoMethod>(&EchoParams {
                value: "hello".to_owned(),
            }),
            Err(CallError::InvalidEnvelope(EnvelopeError::MismatchedId { .. }))
        ));
    }
}
