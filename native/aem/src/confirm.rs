use crate::http::AemError;

/// Exact confirmation gate shared by every write tool (same text as Node `requireConfirmation`).
pub fn require(given: &str, expected: &str) -> Result<(), AemError> {
    if given == expected { Ok(()) } else { Err(AemError::msg(format!("confirmation must equal {expected}"))) }
}
