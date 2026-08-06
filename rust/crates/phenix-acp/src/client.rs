use crate::AcpMethod;
use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use serde_json::value::to_raw_value;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

pub fn encode_extension_request<M: AcpMethod>(
    params: &M::Params,
) -> Result<ExtRequest, ExtensionCodecError> {
    let params = to_raw_value(params).map_err(ExtensionCodecError::EncodeParams)?;
    Ok(ExtRequest::new(M::METHOD, Arc::from(params)))
}

pub fn decode_extension_response<M: AcpMethod>(
    response: ExtResponse,
) -> Result<M::Result, ExtensionCodecError> {
    serde_json::from_str(response.0.get()).map_err(ExtensionCodecError::DecodeResult)
}

#[derive(Debug)]
pub enum ExtensionCodecError {
    EncodeParams(serde_json::Error),
    DecodeResult(serde_json::Error),
}

impl Display for ExtensionCodecError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EncodeParams(error) => {
                write!(
                    formatter,
                    "failed to encode typed Phenix ACP parameters: {error}"
                )
            }
            Self::DecodeResult(error) => {
                write!(
                    formatter,
                    "failed to decode typed Phenix ACP result: {error}"
                )
            }
        }
    }
}

impl Error for ExtensionCodecError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::EncodeParams(error) | Self::DecodeResult(error) => Some(error),
        }
    }
}

#[derive(Debug)]
pub enum PhenixAcpCallError {
    Codec(ExtensionCodecError),
    Acp(agent_client_protocol::Error),
}

impl From<ExtensionCodecError> for PhenixAcpCallError {
    fn from(error: ExtensionCodecError) -> Self {
        Self::Codec(error)
    }
}

impl From<agent_client_protocol::Error> for PhenixAcpCallError {
    fn from(error: agent_client_protocol::Error) -> Self {
        Self::Acp(error)
    }
}

impl Display for PhenixAcpCallError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Codec(error) => Display::fmt(error, formatter),
            Self::Acp(error) => write!(formatter, "ACP operation failed: {error}"),
        }
    }
}

impl Error for PhenixAcpCallError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Codec(error) => Some(error),
            Self::Acp(error) => Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AcpMethod, SessionTreeId};
    use agent_client_protocol::schema::v1::ExtResponse;
    use serde::{Deserialize, Serialize};
    use serde_json::value::to_raw_value;

    struct EchoMethod;

    impl AcpMethod for EchoMethod {
        const METHOD: &'static str = "_phenix/test/echo";
        type Params = EchoParams;
        type Result = EchoResult;
    }

    #[derive(Deserialize, Serialize)]
    struct EchoParams {
        value: String,
    }

    #[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
    struct EchoResult {
        tree_id: SessionTreeId,
    }

    #[test]
    fn typed_method_encodes_as_an_official_acp_extension_request() {
        let request = encode_extension_request::<EchoMethod>(&EchoParams {
            value: "hello".to_owned(),
        })
        .expect("extension request");

        assert_eq!(request.method.as_ref(), EchoMethod::METHOD);
        let params: serde_json::Value =
            serde_json::from_str(request.params.get()).expect("request parameters");
        assert_eq!(params["value"], "hello");
    }

    #[test]
    fn official_acp_extension_response_is_decoded_to_the_linked_result_type() {
        let raw = to_raw_value(&serde_json::json!({ "tree_id": "tree-1" })).expect("response JSON");
        let result = decode_extension_response::<EchoMethod>(ExtResponse::new(Arc::from(raw)))
            .expect("typed response");
        assert_eq!(result.tree_id.as_str(), "tree-1");
    }

    #[test]
    fn malformed_extension_result_is_a_decode_error_not_an_acp_transport_error() {
        let raw = to_raw_value(&serde_json::json!({ "tree_id": 7 })).expect("response JSON");
        assert!(matches!(
            decode_extension_response::<EchoMethod>(ExtResponse::new(Arc::from(raw))),
            Err(ExtensionCodecError::DecodeResult(_))
        ));
    }
}
