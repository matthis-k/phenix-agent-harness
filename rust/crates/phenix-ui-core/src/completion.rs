use crate::AppState;
use std::collections::BTreeMap;

pub const MAX_COMMAND_COMPLETIONS: usize = 8;

const BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("abort", "Interrupt the selected run"),
    ("compact", "Compact the selected session"),
    ("exit", "Exit Phenix"),
    ("login", "Authenticate a provider"),
    ("logout", "Log out a provider"),
    ("mode", "Inspect or select an ACP session mode"),
    ("model", "Select a concrete model"),
    ("new", "Create a new session"),
    ("quit", "Exit Phenix"),
    ("reload", "Reload backend resources"),
    ("resume", "Resume a persisted session"),
    ("routing", "Select a Phenix routing profile"),
    ("sessions", "Open the session picker"),
    ("thinking", "Inspect available thinking levels"),
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandCompletion {
    pub command: String,
    pub description: Option<String>,
}

pub fn command_completions(state: &AppState) -> Vec<CommandCompletion> {
    let Some(query) = state.input.text.strip_prefix('/') else {
        return Vec::new();
    };
    if query.chars().any(char::is_whitespace) {
        return Vec::new();
    }

    let mut commands = BTreeMap::new();
    for (command, description) in BUILTIN_COMMANDS {
        commands.insert(
            (*command).to_owned(),
            CommandCompletion {
                command: format!("/{command}"),
                description: Some((*description).to_owned()),
            },
        );
    }
    for command in &state.commands {
        commands
            .entry(command.name.clone())
            .and_modify(|completion| {
                if command.description.is_some() {
                    completion.description = command.description.clone();
                }
            })
            .or_insert_with(|| CommandCompletion {
                command: format!("/{}", command.name),
                description: command.description.clone(),
            });
    }

    let exact_input = state.input.text.as_str();
    commands
        .into_iter()
        .filter(|(command, _)| command.starts_with(query))
        .map(|(_, completion)| completion)
        .filter(|completion| completion.command != exact_input)
        .take(MAX_COMMAND_COMPLETIONS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_is_vertical_data_with_descriptions() {
        let mut state = AppState::default();
        state.input.replace("/mo".to_owned());
        let completions = command_completions(&state);
        assert_eq!(
            completions
                .iter()
                .map(|completion| completion.command.as_str())
                .collect::<Vec<_>>(),
            vec!["/mode", "/model"]
        );
        assert!(completions
            .iter()
            .all(|completion| completion.description.is_some()));
    }

    #[test]
    fn routing_is_a_native_completion() {
        let mut state = AppState::default();
        state.input.replace("/rou".to_owned());
        assert_eq!(command_completions(&state)[0].command, "/routing");
    }

    #[test]
    fn exact_or_argument_bearing_commands_do_not_keep_completion_open() {
        let mut state = AppState::default();
        state.input.replace("/model".to_owned());
        assert!(command_completions(&state).is_empty());
        state.input.replace("/routing mixed".to_owned());
        assert!(command_completions(&state).is_empty());
    }
}
