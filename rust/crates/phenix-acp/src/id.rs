use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdError {
    Empty,
    TooLong { length: usize, maximum: usize },
    ControlCharacter,
}

impl Display for IdError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("identifier must not be empty"),
            Self::TooLong { length, maximum } => {
                write!(
                    formatter,
                    "identifier length {length} exceeds maximum {maximum}"
                )
            }
            Self::ControlCharacter => {
                formatter.write_str("identifier must not contain control characters")
            }
        }
    }
}

impl Error for IdError {}

fn validate(value: String) -> Result<String, IdError> {
    const MAXIMUM_LENGTH: usize = 1_024;
    if value.is_empty() {
        return Err(IdError::Empty);
    }
    if value.len() > MAXIMUM_LENGTH {
        return Err(IdError::TooLong {
            length: value.len(),
            maximum: MAXIMUM_LENGTH,
        });
    }
    if value.chars().any(char::is_control) {
        return Err(IdError::ControlCharacter);
    }
    Ok(value)
}

macro_rules! define_id {
    ($name:ident) => {
        #[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
                validate(value.into()).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Debug for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_tuple(stringify!($name))
                    .field(&self.0)
                    .finish()
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::parse(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

define_id!(AcpSessionId);
define_id!(ArtifactId);
define_id!(BackendId);
define_id!(CallableId);
define_id!(DefinitionId);
define_id!(McpServerName);
define_id!(ModelId);
define_id!(ObjectiveId);
define_id!(ProviderId);
define_id!(RoleId);
define_id!(RunId);
define_id!(RouterId);
define_id!(SchemaId);
define_id!(SessionNodeId);
define_id!(SessionTreeId);
define_id!(ToolId);
define_id!(WorkflowId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nominal_ids_reject_empty_and_control_character_values() {
        assert_eq!(SessionTreeId::parse(""), Err(IdError::Empty));
        assert_eq!(
            SessionTreeId::parse("tree\nother"),
            Err(IdError::ControlCharacter)
        );
    }

    #[test]
    fn deserialization_revalidates_wire_ids() {
        let error = serde_json::from_str::<SessionTreeId>("\"\"")
            .expect_err("empty wire identifier must fail");
        assert!(error.to_string().contains("must not be empty"));
    }
}
