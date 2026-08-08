use phenix_frontend_config::{LayoutNode, SplitDirection};
use phenix_ui_core::{AppState, ElementId, InputEditor};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use std::collections::BTreeMap;

const OUTER_GUTTER: u16 = 1;
const PANE_GUTTER: u16 = 1;
const OWNED_INPUT_MIN_HEIGHT: u16 = 5;
const OWNED_INPUT_MAX_HEIGHT: u16 = 10;

pub(crate) fn collect_layout(
    node: &LayoutNode,
    area: Rect,
    state: &AppState,
    output: &mut BTreeMap<ElementId, Rect>,
) {
    collect_layout_inner(node, inset_workspace(area), state, output);
}

fn collect_layout_inner(
    node: &LayoutNode,
    area: Rect,
    state: &AppState,
    output: &mut BTreeMap<ElementId, Rect>,
) {
    if !node_is_visible(node, state) || area.width == 0 || area.height == 0 {
        return;
    }
    match node {
        LayoutNode::Pane(pane) => {
            output.insert(pane.element.clone(), area);
        }
        LayoutNode::Split(split) => {
            if split.children.is_empty() {
                return;
            }
            let direction = match split.direction {
                SplitDirection::Horizontal => Direction::Horizontal,
                SplitDirection::Vertical => Direction::Vertical,
            };
            let last_visible = split
                .children
                .iter()
                .rposition(|child| node_is_visible(child, state));
            let mut slots = Vec::with_capacity(split.children.len().saturating_mul(2));
            for (index, child) in split.children.iter().enumerate() {
                slots.push((
                    Some(index),
                    child_constraint(child, split.direction, area, state),
                ));
                if node_is_visible(child, state) && Some(index) != last_visible {
                    let next_visible = split
                        .children
                        .iter()
                        .skip(index + 1)
                        .find(|candidate| node_is_visible(candidate, state));
                    if !input_status_pair(child, next_visible, split.direction) {
                        slots.push((None, Constraint::Length(PANE_GUTTER)));
                    }
                }
            }
            let constraints = slots
                .iter()
                .map(|(_, constraint)| *constraint)
                .collect::<Vec<_>>();
            let slot_areas = Layout::default()
                .direction(direction)
                .constraints(constraints)
                .split(area);
            for ((child_index, _), child_area) in slots.iter().zip(slot_areas.iter().copied()) {
                if let Some(child_index) = child_index {
                    collect_layout_inner(&split.children[*child_index], child_area, state, output);
                }
            }
        }
    }
}

fn input_status_pair(
    current: &LayoutNode,
    next: Option<&LayoutNode>,
    direction: SplitDirection,
) -> bool {
    direction == SplitDirection::Vertical
        && pane_is(current, &ElementId::input())
        && next.is_some_and(|node| pane_is(node, &ElementId::status()))
}

fn pane_is(node: &LayoutNode, element: &ElementId) -> bool {
    matches!(node, LayoutNode::Pane(pane) if &pane.element == element)
}

fn inset_workspace(area: Rect) -> Rect {
    if area.width <= OUTER_GUTTER.saturating_mul(2) || area.height <= OUTER_GUTTER.saturating_mul(2)
    {
        return area;
    }
    Rect {
        x: area.x.saturating_add(OUTER_GUTTER),
        y: area.y.saturating_add(OUTER_GUTTER),
        width: area.width.saturating_sub(OUTER_GUTTER.saturating_mul(2)),
        height: area.height.saturating_sub(OUTER_GUTTER.saturating_mul(2)),
    }
}

fn child_constraint(
    node: &LayoutNode,
    direction: SplitDirection,
    area: Rect,
    state: &AppState,
) -> Constraint {
    if !node_is_visible(node, state) {
        return Constraint::Length(0);
    }
    match node {
        LayoutNode::Pane(pane) => {
            if let (Some(minimum), Some(maximum)) = (pane.minimum, pane.maximum) {
                if minimum == maximum {
                    return Constraint::Length(minimum);
                }
            }

            if direction == SplitDirection::Vertical
                && pane.element == ElementId::input()
                && state.view.input_editor == InputEditor::Owned
            {
                return Constraint::Length(owned_input_height(&state.input.text, area.width));
            }

            let view = state.view.pane(&pane.element);
            let explicit = match direction {
                SplitDirection::Horizontal => view.width,
                SplitDirection::Vertical => view.height,
            };
            if let Some(explicit) = explicit {
                return Constraint::Length(explicit);
            }
            match (pane.minimum, pane.maximum) {
                (Some(minimum), None) => Constraint::Min(minimum),
                (None, Some(maximum)) => Constraint::Max(maximum),
                _ => Constraint::Fill(pane.weight.max(1)),
            }
        }
        LayoutNode::Split(split) => Constraint::Fill(layout_weight(&split.children, state).max(1)),
    }
}

fn owned_input_height(text: &str, width: u16) -> u16 {
    let width = usize::from(width.max(1));
    let visual_lines = if text.is_empty() {
        1usize
    } else {
        text.split('\n')
            .map(|line| {
                let characters = line.chars().count();
                characters.max(1).div_ceil(width)
            })
            .sum()
    };
    u16::try_from(visual_lines)
        .unwrap_or(u16::MAX)
        .clamp(OWNED_INPUT_MIN_HEIGHT, OWNED_INPUT_MAX_HEIGHT)
}

fn node_is_visible(node: &LayoutNode, state: &AppState) -> bool {
    match node {
        LayoutNode::Pane(pane) => state.view.pane(&pane.element).visible,
        LayoutNode::Split(split) => split
            .children
            .iter()
            .any(|child| node_is_visible(child, state)),
    }
}

fn layout_weight(nodes: &[LayoutNode], state: &AppState) -> u16 {
    nodes.iter().fold(0u16, |total, node| {
        if !node_is_visible(node, state) {
            return total;
        }
        total.saturating_add(match node {
            LayoutNode::Pane(pane) => pane.weight.max(1),
            LayoutNode::Split(split) => layout_weight(&split.children, state).max(1),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_frontend_config::{LayoutConfig, PaneLayout, PaneType, SplitLayout};

    fn transcript_sidebar_layout() -> LayoutNode {
        LayoutConfig {
            root: LayoutNode::Split(SplitLayout {
                direction: SplitDirection::Horizontal,
                children: vec![
                    LayoutNode::Pane(PaneLayout {
                        element: ElementId::transcript(),
                        pane_type: PaneType::Transcript,
                        weight: 3,
                        minimum: None,
                        maximum: None,
                    }),
                    LayoutNode::Pane(PaneLayout {
                        element: ElementId::sidebar(),
                        pane_type: PaneType::Sidebar,
                        weight: 1,
                        minimum: None,
                        maximum: None,
                    }),
                ],
            }),
        }
        .root
    }

    #[test]
    fn semantic_layout_is_projected_with_canvas_gutters() {
        let state = AppState::default();
        let mut output = BTreeMap::new();
        collect_layout(
            &transcript_sidebar_layout(),
            Rect::new(0, 0, 100, 20),
            &state,
            &mut output,
        );
        let transcript = output[&ElementId::transcript()];
        let sidebar = output[&ElementId::sidebar()];
        assert_eq!(transcript.x, 1);
        assert_eq!(sidebar.width, 28);
        assert_eq!(transcript.x + transcript.width + PANE_GUTTER, sidebar.x);
        assert_eq!(sidebar.x + sidebar.width, 99);
    }

    #[test]
    fn hidden_sidebar_returns_its_width_to_the_transcript() {
        let mut state = AppState::default();
        state.view.pane_mut(ElementId::sidebar()).visible = false;
        let mut output = BTreeMap::new();
        collect_layout(
            &transcript_sidebar_layout(),
            Rect::new(0, 0, 100, 20),
            &state,
            &mut output,
        );
        assert!(!output.contains_key(&ElementId::sidebar()));
        assert_eq!(output[&ElementId::transcript()].x, 1);
        assert_eq!(output[&ElementId::transcript()].width, 98);
    }

    #[test]
    fn hidden_nested_split_reserves_no_space() {
        let mut state = AppState::default();
        state.view.pane_mut(ElementId::input()).visible = false;
        state.view.pane_mut(ElementId::status()).visible = false;
        let nested = LayoutNode::Split(SplitLayout {
            direction: SplitDirection::Horizontal,
            children: vec![
                LayoutNode::Pane(PaneLayout {
                    element: ElementId::transcript(),
                    pane_type: PaneType::Transcript,
                    weight: 1,
                    minimum: None,
                    maximum: None,
                }),
                LayoutNode::Split(SplitLayout {
                    direction: SplitDirection::Vertical,
                    children: vec![
                        LayoutNode::Pane(PaneLayout {
                            element: ElementId::input(),
                            pane_type: PaneType::Input,
                            weight: 1,
                            minimum: None,
                            maximum: None,
                        }),
                        LayoutNode::Pane(PaneLayout {
                            element: ElementId::status(),
                            pane_type: PaneType::Status,
                            weight: 1,
                            minimum: None,
                            maximum: None,
                        }),
                    ],
                }),
            ],
        });
        let mut output = BTreeMap::new();
        collect_layout(&nested, Rect::new(0, 0, 80, 20), &state, &mut output);
        assert_eq!(output[&ElementId::transcript()], Rect::new(1, 1, 78, 18));
    }

    #[test]
    fn fixed_panes_keep_their_extent_while_gutters_use_flexible_space() {
        let mut state = AppState::default();
        state.view.pane_mut(ElementId::input()).height = None;
        let mut output = BTreeMap::new();
        collect_layout(
            &LayoutNode::Split(SplitLayout {
                direction: SplitDirection::Vertical,
                children: vec![
                    LayoutNode::Pane(PaneLayout {
                        element: ElementId::transcript(),
                        pane_type: PaneType::Transcript,
                        weight: 1,
                        minimum: None,
                        maximum: None,
                    }),
                    LayoutNode::Pane(PaneLayout {
                        element: ElementId::input(),
                        pane_type: PaneType::Input,
                        weight: 1,
                        minimum: Some(4),
                        maximum: Some(4),
                    }),
                ],
            }),
            Rect::new(0, 0, 80, 24),
            &state,
            &mut output,
        );
        assert_eq!(output[&ElementId::input()].height, 4);
        assert_eq!(output[&ElementId::transcript()].height, 17);
        assert_eq!(
            output[&ElementId::transcript()].y
                + output[&ElementId::transcript()].height
                + PANE_GUTTER,
            output[&ElementId::input()].y
        );
    }

    #[test]
    fn owned_input_grows_with_lines_and_wraps_up_to_a_maximum() {
        assert_eq!(owned_input_height("", 40), 5);
        assert_eq!(owned_input_height("one\ntwo\nthree", 40), 5);
        assert_eq!(owned_input_height(&"x".repeat(100), 20), 5);
        assert_eq!(owned_input_height(&"x".repeat(120), 20), 6);
        assert_eq!(
            owned_input_height(&"x".repeat(1000), 20),
            OWNED_INPUT_MAX_HEIGHT
        );
    }

    #[test]
    fn input_and_status_share_one_visual_surface_without_a_gutter() {
        let state = AppState::default();
        let layout = LayoutNode::Split(SplitLayout {
            direction: SplitDirection::Vertical,
            children: vec![
                LayoutNode::Pane(PaneLayout {
                    element: ElementId::transcript(),
                    pane_type: PaneType::Transcript,
                    weight: 1,
                    minimum: None,
                    maximum: None,
                }),
                LayoutNode::Pane(PaneLayout {
                    element: ElementId::input(),
                    pane_type: PaneType::Input,
                    weight: 1,
                    minimum: None,
                    maximum: None,
                }),
                LayoutNode::Pane(PaneLayout {
                    element: ElementId::status(),
                    pane_type: PaneType::Status,
                    weight: 1,
                    minimum: Some(1),
                    maximum: Some(1),
                }),
            ],
        });
        let mut output = BTreeMap::new();
        collect_layout(&layout, Rect::new(0, 0, 80, 24), &state, &mut output);
        let input = output[&ElementId::input()];
        let status = output[&ElementId::status()];
        assert_eq!(input.y + input.height, status.y);
    }
}
