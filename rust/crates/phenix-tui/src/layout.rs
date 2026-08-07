use phenix_frontend_config::{LayoutNode, SplitDirection};
use phenix_ui_core::{AppState, ElementId};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use std::collections::BTreeMap;

pub(crate) fn collect_layout(
    node: &LayoutNode,
    area: Rect,
    state: &AppState,
    output: &mut BTreeMap<ElementId, Rect>,
) {
    match node {
        LayoutNode::Pane(pane) => {
            if state.view.pane(&pane.element).visible && area.width > 0 && area.height > 0 {
                output.insert(pane.element.clone(), area);
            }
        }
        LayoutNode::Split(split) => {
            if split.children.is_empty() {
                return;
            }
            let direction = match split.direction {
                SplitDirection::Horizontal => Direction::Horizontal,
                SplitDirection::Vertical => Direction::Vertical,
            };
            let constraints = split
                .children
                .iter()
                .map(|child| child_constraint(child, split.direction, state))
                .collect::<Vec<_>>();
            let child_areas = Layout::default()
                .direction(direction)
                .constraints(constraints)
                .split(area);
            for (child, child_area) in split.children.iter().zip(child_areas.iter().copied()) {
                collect_layout(child, child_area, state, output);
            }
        }
    }
}

fn child_constraint(node: &LayoutNode, direction: SplitDirection, state: &AppState) -> Constraint {
    match node {
        LayoutNode::Pane(pane) => {
            let view = state.view.pane(&pane.element);
            if !view.visible {
                return Constraint::Length(0);
            }
            let explicit = match direction {
                SplitDirection::Horizontal => view.width,
                SplitDirection::Vertical => view.height,
            };
            if let Some(explicit) = explicit {
                return Constraint::Length(explicit);
            }
            match (pane.minimum, pane.maximum) {
                (Some(minimum), Some(maximum)) if minimum == maximum => Constraint::Length(minimum),
                (Some(minimum), None) => Constraint::Min(minimum),
                (None, Some(maximum)) => Constraint::Max(maximum),
                _ => Constraint::Fill(pane.weight.max(1)),
            }
        }
        LayoutNode::Split(split) => Constraint::Fill(layout_weight(&split.children).max(1)),
    }
}

fn layout_weight(nodes: &[LayoutNode]) -> u16 {
    nodes.iter().fold(0u16, |total, node| {
        total.saturating_add(match node {
            LayoutNode::Pane(pane) => pane.weight.max(1),
            LayoutNode::Split(split) => layout_weight(&split.children).max(1),
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
    fn semantic_layout_is_projected_without_widget_state() {
        let mut state = AppState::default();
        state.view.pane_mut(ElementId::sidebar()).visible = true;
        let mut output = BTreeMap::new();
        collect_layout(
            &transcript_sidebar_layout(),
            Rect::new(0, 0, 100, 20),
            &state,
            &mut output,
        );
        assert!(output.contains_key(&ElementId::transcript()));
        assert_eq!(output[&ElementId::sidebar()].width, 28);
    }

    #[test]
    fn hidden_sidebar_returns_its_width_to_the_transcript() {
        let state = AppState::default();
        let mut output = BTreeMap::new();
        collect_layout(
            &transcript_sidebar_layout(),
            Rect::new(0, 0, 100, 20),
            &state,
            &mut output,
        );
        assert!(!output.contains_key(&ElementId::sidebar()));
        assert_eq!(output[&ElementId::transcript()].width, 100);
    }

    #[test]
    fn equal_minimum_and_maximum_reserve_a_fixed_pane_extent() {
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
        assert_eq!(output[&ElementId::transcript()].height, 20);
    }
}
