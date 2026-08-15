use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::str::FromStr;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidId;

impl Display for InvalidId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("identifier must not be empty")
    }
}

impl Error for InvalidId {}

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, InvalidId> {
                let value = value.into();
                if value.trim().is_empty() {
                    Err(InvalidId)
                } else {
                    Ok(Self(value))
                }
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = InvalidId;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }
    };
}

string_id!(SessionId);
string_id!(ExecutionId);
string_id!(CallableId);
string_id!(ToolCallId);
