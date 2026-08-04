use std::error::Error;
use std::fmt::{self, Display, Formatter};

const MAX_ID_BYTES: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidId {
    kind: &'static str,
    reason: &'static str,
}

impl InvalidId {
    fn new(kind: &'static str, reason: &'static str) -> Self {
        Self { kind, reason }
    }
}

impl Display for InvalidId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.kind, self.reason)
    }
}

impl Error for InvalidId {}

macro_rules! string_id {
    ($name:ident, $kind:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, InvalidId> {
                let value = value.into();
                validate_id($kind, &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl TryFrom<String> for $name {
            type Error = InvalidId;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = InvalidId;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }
    };
}

string_id!(RequestId, "request ID");
string_id!(SessionId, "persisted session ID");
string_id!(SessionEntryId, "session entry ID");
string_id!(RunId, "run ID");
string_id!(ObjectiveId, "objective ID");
string_id!(ToolCallId, "tool-call ID");
string_id!(DialogId, "dialog ID");
string_id!(AuthFlowId, "authentication-flow ID");

fn validate_id(kind: &'static str, value: &str) -> Result<(), InvalidId> {
    if value.is_empty() {
        return Err(InvalidId::new(kind, "must not be empty"));
    }
    if value.len() > MAX_ID_BYTES {
        return Err(InvalidId::new(kind, "is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(InvalidId::new(kind, "must not contain control characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_control_character_ids() {
        assert!(SessionId::parse("").is_err());
        assert!(SessionId::parse("session\nother").is_err());
        assert_eq!(
            RunId::parse("run:child-1")
                .expect("valid ID")
                .as_str(),
            "run:child-1"
        );
    }

    #[test]
    fn nominal_id_types_cannot_be_interchanged_accidentally() {
        let run = RunId::parse("shared-value").expect("valid run ID");
        let session = SessionId::parse("shared-value").expect("valid session ID");
        assert_eq!(run.as_str(), session.as_str());
    }
}
