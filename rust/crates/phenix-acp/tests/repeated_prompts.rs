#[test]
fn acp_crate_is_only_a_wire_boundary() {
    assert_eq!(phenix_acp::WIRE_PROTOCOL_NAME, "acp");
}
