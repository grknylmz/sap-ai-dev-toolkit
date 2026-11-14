//! Read-only guard. Heuristic by nature (GUI-level): the real guarantee is a
//! display-only SAP user. Blocks transactions that change or execute
//! arbitrary code, function codes that save/post/delete, and buttons whose
//! text, tooltip or function key means a change.

/// Transactions that edit data, run arbitrary programs, or administer the system.
const BLOCKED_TCODES: &[&str] = &[
    "SE38", "SA38", "SE37", "SE24", "SE80", "SE11", "SE14", "SE93", "SE09", "SE10", "SE01", "SM30", "SM31", "SM34", "SM36", "SM36WIZ", "SM49", "SM69",
    "SU01", "SU10", "SU02", "SU03", "SU3", "SCC1", "SCC4", "SCC5", "SCCL", "SCC3", "SM02", "SM63", "RZ10", "RZ11", "ST05", "SQ01", "SQ02", "SE19",
    "SE18", "SMOD", "CMOD", "SNOTE", "SPAM", "SAINT", "SE03", "SM35", "SHDB", "SE30", "SE36", "SECATT",
];

/// Function codes (OK codes) that save, post, delete, change or activate.
const BLOCKED_FCODES: &[&str] = &[
    "/11", "BU", "SAVE", "SICH", "UPDA", "UPD", "POST", "DEL", "DELE", "LOES", "DELETE", "AKTI", "ACTI", "ACT", "AEND", "CHAN", "CHNG", "EDIT", "ANLE",
    "CREA", "CREATE", "COPY", "KOPI", "RELE", "FREI", "IMPO", "IMPORT", "&SAP_EDIT", "SAP_EDIT", "LOCK", "UNLOCK", "SPER", "ENTS", "TERM", "KILL", "STOP",
    "CANC", "STOR", "/H", "/HS", "/O", "/I", "/$SYNC", "/$TAB", "/$CUA", "/$NAM", "/$DYNP",
];

/// Words in a button's text or tooltip that indicate a change.
const BLOCKED_WORDS: &[&str] = &[
    "save", "delete", "post", "activate", "deactivate", "release", "create", "change", "edit", "insert", "import", "transport", "lock", "unlock",
    "schedule", "reschedule", "stop", "terminate", "kill", "reset", "copy", "rename", "transfer", "assign", "generate", "upload", "approve", "reject",
    "repair", "modify", "maintain", "remove", "cancel job", "cancel process", "end session", "end process", "debug", "debugging", "repeat scheduling",
    "new entries", "mass change", "set password", "password",
];

/// Function keys that save on every SAP screen.
const SAVE_FKEYS: &[&str] = &["F11", "CTRL_S"];
/// Keys refused when sent without a visible button (Shift+F2 deletes on many screens).
const BLOCKED_RAW_FKEYS: &[&str] = &["F11", "CTRL_S", "SHIFT_F2"];

pub fn tcode_of(okcode: &str) -> Option<String> {
    let upper = okcode.trim().to_ascii_uppercase();
    let rest = upper.strip_prefix("/N").or_else(|| upper.strip_prefix("/*")).or_else(|| upper.strip_prefix("/O"))?;
    let tcode = rest.split_whitespace().next().unwrap_or("");
    (!tcode.is_empty()).then(|| tcode.to_owned())
}

pub fn check_tcode(tcode: &str) -> Result<(), String> {
    let upper = tcode.trim().to_ascii_uppercase();
    if upper.is_empty() || !upper.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/')) {
        return Err(format!("invalid transaction code {tcode:?}"));
    }
    if BLOCKED_TCODES.contains(&upper.as_str()) {
        return Err(format!("read-only mode: transaction {upper} edits data, runs arbitrary programs, or administers the system; use the ADT tools (sap-ai-dev) for development objects"));
    }
    Ok(())
}

pub fn check_okcode(okcode: &str) -> Result<(), String> {
    let upper = okcode.trim().to_ascii_uppercase();
    if upper.is_empty() || matches!(upper.as_str(), "/N" | "/NEX" | "P+" | "P-" | "P++" | "P--" | "/12" | "/3" | "/15" | "/8" | "BACK" | "%EX" | "RW") {
        return Ok(());
    }
    if upper.starts_with("/*") || upper.starts_with("/O") {
        return Err(format!("read-only mode: OK code {upper} is not allowed (/* skips the first screen, /o opens extra sessions)"));
    }
    if let Some(tcode) = tcode_of(&upper) {
        return check_tcode(&tcode);
    }
    let code = upper.trim_start_matches('=');
    if BLOCKED_FCODES.iter().any(|b| code == *b || (b.len() >= 4 && code.starts_with(b))) {
        return Err(format!("read-only mode: function code {upper} saves, posts, deletes, changes or ends something"));
    }
    if code.starts_with('/') && !code.starts_with("/N") {
        return Err(format!("read-only mode: system command {upper} is not allowed"));
    }
    Ok(())
}

fn word_hit(haystack: &str) -> Option<&'static str> {
    let lower = haystack.to_ascii_lowercase();
    BLOCKED_WORDS.iter().copied().find(|word| {
        lower.match_indices(word).any(|(i, _)| {
            let before = lower[..i].chars().next_back();
            let after = lower[i + word.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_alphanumeric()) && !after.is_some_and(|c| c.is_ascii_alphanumeric())
        })
    })
}

pub fn check_button(text: &str, fkey: Option<&str>) -> Result<(), String> {
    if let Some(fkey) = fkey.map(|f| f.to_ascii_uppercase())
        && SAVE_FKEYS.contains(&fkey.as_str())
    {
        return Err(format!("read-only mode: {fkey} saves or deletes on SAP screens"));
    }
    if let Some(word) = word_hit(text) {
        return Err(format!("read-only mode: button \"{}\" looks like a change action ({word})", text.trim()));
    }
    Ok(())
}

pub fn check_fkey(fkey: &str) -> Result<(), String> {
    let upper = fkey.trim().to_ascii_uppercase();
    if BLOCKED_RAW_FKEYS.contains(&upper.as_str()) {
        return Err(format!("read-only mode: {upper} saves or deletes on SAP screens"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_saving_function_codes_and_write_transactions() {
        assert!(check_okcode("/11").is_err());
        assert!(check_okcode("=BU").is_err());
        assert!(check_okcode("&SAP_EDIT").is_err());
        assert!(check_okcode("DELETE_ALL").is_err());
        assert!(check_okcode("/nSE38").is_err());
        assert!(check_okcode("/osm37").is_err());
        assert!(check_okcode("/h").is_err());
        assert!(check_tcode("su01").is_err());
    }

    #[test]
    fn allows_display_navigation() {
        for ok in ["", "/nSM37", "/nSU01D", "/nex", "P+", "SHOW", "/n", "ONLI", "PICK"] {
            assert!(check_okcode(ok).is_ok(), "{ok}");
        }
        assert!(check_tcode("SE16N").is_ok());
    }

    #[test]
    fn button_words_and_fkeys() {
        assert!(check_button("Delete job from database", None).is_err());
        assert!(check_button("Release", None).is_err());
        assert!(check_button("Save (Ctrl+S)", None).is_err());
        assert!(check_button("Anything", Some("F11")).is_err());
        assert!(check_button("Execute (F8)", Some("F8")).is_ok());
        assert!(check_button("Display (F7)", Some("F7")).is_ok());
        assert!(check_button("Back (F3)", Some("F3")).is_ok());
        assert!(check_button("Changed by", None).is_ok());
    }
}
