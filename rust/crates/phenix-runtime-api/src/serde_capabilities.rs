use crate::{
    AuthenticationCapabilities, BackendCapabilities, ExtensionUiCapabilities, ModelCapabilities,
    PromptCapabilities, ResourceCapabilities, SessionCapabilities,
};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

macro_rules! impl_struct_serde {
    ($type:ty, $name:literal, { $($field:ident: $field_type:ty),+ $(,)? }) => {
        impl Serialize for $type {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                let mut state = serializer.serialize_struct(
                    $name,
                    [$(stringify!($field)),+].len(),
                )?;
                $(state.serialize_field(stringify!($field), &self.$field)?;)+
                state.end()
            }
        }

        impl<'de> Deserialize<'de> for $type {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                #[derive(Deserialize)]
                struct Repr {
                    $($field: $field_type,)+
                }

                let repr = Repr::deserialize(deserializer)?;
                Ok(Self {
                    $($field: repr.$field,)+
                })
            }
        }
    };
}

impl_struct_serde!(PromptCapabilities, "PromptCapabilities", {
    steering: bool,
    follow_ups: bool,
    images: bool,
    compaction: bool,
    retry_control: bool,
});

impl_struct_serde!(SessionCapabilities, "SessionCapabilities", {
    persistence: bool,
    switching: bool,
    branching: bool,
    import: bool,
    export: bool,
    tree: bool,
});

impl_struct_serde!(AuthenticationCapabilities, "AuthenticationCapabilities", {
    provider_listing: bool,
    oauth: bool,
    api_keys: bool,
    terminal: bool,
    device_code: bool,
    browser_callback: bool,
    logout: bool,
});

impl_struct_serde!(ModelCapabilities, "ModelCapabilities", {
    listing: bool,
    selection: bool,
    thinking_levels: bool,
    virtual_models: bool,
});

impl_struct_serde!(ResourceCapabilities, "ResourceCapabilities", {
    commands: bool,
    extensions: bool,
    skills: bool,
    prompt_templates: bool,
    reload: bool,
});

impl_struct_serde!(ExtensionUiCapabilities, "ExtensionUiCapabilities", {
    selection: bool,
    confirmation: bool,
    text_input: bool,
    secret_input: bool,
    editor: bool,
    notifications: bool,
    status: bool,
});

impl_struct_serde!(BackendCapabilities, "BackendCapabilities", {
    prompting: PromptCapabilities,
    sessions: SessionCapabilities,
    authentication: AuthenticationCapabilities,
    models: ModelCapabilities,
    resources: ResourceCapabilities,
    extension_ui: ExtensionUiCapabilities,
});
