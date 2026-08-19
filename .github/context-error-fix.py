from pathlib import Path

path = Path("rust/crates/phenix-conductor/src/server.rs")
text = path.read_text()
old = '''        ConductorError::Routing(error) => {
            protocol_error(ErrorCode::RoutingFailure, error.to_string())
        }
        ConductorError::Backend(error) => map_backend_error(error),
'''
new = '''        ConductorError::Routing(error) => {
            protocol_error(ErrorCode::RoutingFailure, error.to_string())
        }
        ConductorError::Context(error) => {
            protocol_error(ErrorCode::InvalidRequest, error.to_string())
        }
        ConductorError::Backend(error) => map_backend_error(error),
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one mapping anchor, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
