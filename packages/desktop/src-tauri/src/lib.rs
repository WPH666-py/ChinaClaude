//! Library surface of the desktop shell.
//!
//! The binary entry point lives in `main.rs`; this module exists so the crate also builds
//! as a library (needed by the `staticlib`/`rlib` crate types) and so integration tests can
//! reach shared helpers later.

pub use std::process::Child;

/// Version string surfaced to the UI and to crash reports.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The single window the shell creates.
pub const MAIN_WINDOW_LABEL: &str = "main";
