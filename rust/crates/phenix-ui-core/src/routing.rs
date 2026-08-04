use std::error::Error;
use std::fmt::{self, Display, Formatter};

const MAX_ELEMENT_ID_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ElementId(String);

impl ElementId {
    pub fn parse(value: impl Into<String>) -> Result<Self, InvalidElementId> {
        let value = value.into();
        if value.is_empty() {
            return Err(InvalidElementId("must not be empty"));
        }
        if value.len() > MAX_ELEMENT_ID_BYTES {
            return Err(InvalidElementId("is too long"));
        }
        if value.chars().any(char::is_control) {
            return Err(InvalidElementId("must not contain control characters"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn root() -> Self {
        Self("ui.root".to_owned())
    }

    pub fn layout() -> Self {
        Self("ui.layout".to_owned())
    }

    pub fn sidebar() -> Self {
        Self("ui.sidebar".to_owned())
    }

    pub fn transcript() -> Self {
        Self("ui.transcript".to_owned())
    }

    pub fn input() -> Self {
        Self("ui.input".to_owned())
    }

    pub fn status() -> Self {
        Self("ui.status".to_owned())
    }

    pub fn overlay() -> Self {
        Self("ui.overlay".to_owned())
    }
}

impl Display for ElementId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidElementId(&'static str);

impl Display for InvalidElementId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid UI element ID: {}", self.0)
    }
}

impl Error for InvalidElementId {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteTarget {
    Broadcast,
    Focused,
    Element(ElementId),
    Subtree(ElementId),
    Bubble(ElementId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventEnvelope<T> {
    pub source: Option<ElementId>,
    pub target: RouteTarget,
    pub event: T,
}

impl<T> EventEnvelope<T> {
    pub fn broadcast(event: T) -> Self {
        Self {
            source: None,
            target: RouteTarget::Broadcast,
            event,
        }
    }

    pub fn focused(event: T) -> Self {
        Self {
            source: None,
            target: RouteTarget::Focused,
            event,
        }
    }

    pub fn to(target: ElementId, event: T) -> Self {
        Self {
            source: None,
            target: RouteTarget::Element(target),
            event,
        }
    }

    pub fn from(mut self, source: ElementId) -> Self {
        self.source = Some(source);
        self
    }

    pub fn map<U>(self, map: impl FnOnce(T) -> U) -> EventEnvelope<U> {
        EventEnvelope {
            source: self.source,
            target: self.target,
            event: map(self.event),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_ids_are_validated_at_the_boundary() {
        assert!(ElementId::parse("").is_err());
        assert!(ElementId::parse("pane\nother").is_err());
        assert_eq!(
            ElementId::parse("workspace.transcript")
                .expect("valid element ID")
                .as_str(),
            "workspace.transcript"
        );
    }

    #[test]
    fn envelopes_keep_source_and_routing_separate_from_payload() {
        let envelope = EventEnvelope::to(ElementId::layout(), "grow")
            .from(ElementId::sidebar());
        assert_eq!(envelope.source, Some(ElementId::sidebar()));
        assert_eq!(envelope.target, RouteTarget::Element(ElementId::layout()));
        assert_eq!(envelope.event, "grow");
    }
}
