//! wisp-extensions: server-side flows for the Wisp v2 extensions.

pub mod keyauth;
pub mod password;

pub use keyauth::KeyAuth;
pub use password::PasswordAuth;
