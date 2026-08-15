use clap::Parser;
use phenix_conductor::ConductorRuntime;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "phenix-conductor",
    version,
    about = "Phenix application runtime"
)]
struct Arguments {
    /// Working directory associated with the frontend connection.
    #[arg(long, value_name = "DIR")]
    cwd: Option<PathBuf>,
}

fn main() {
    let _arguments = Arguments::parse();
    let _runtime = ConductorRuntime::new();
}
