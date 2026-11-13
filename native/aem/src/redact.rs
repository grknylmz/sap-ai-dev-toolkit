//! Recursive secret redaction applied to every tool result.
use serde_json::Value;

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("password")
        || key.contains("secret")
        || key.contains("logincredential")
        || matches!(key.as_str(), "token" | "apitoken" | "authorization")
}

pub fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let value = if is_secret_key(&key) { Value::String("[redacted]".into()) } else { redact(value) };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(redact).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_nested_credentials() {
        let value = redact(json!({
            "broker": { "msgVpns": [{
                "missionControlManagerLoginCredential": { "username": "u", "password": "p" },
                "clientUsername": "app",
                "settings": { "password": "x", "token": "t", "tokenCount": 3 }
            }]}
        }));
        let vpn = &value["broker"]["msgVpns"][0];
        assert_eq!(vpn["missionControlManagerLoginCredential"], "[redacted]");
        assert_eq!(vpn["settings"]["password"], "[redacted]");
        assert_eq!(vpn["settings"]["token"], "[redacted]");
        assert_eq!(vpn["settings"]["tokenCount"], 3);
        assert_eq!(vpn["clientUsername"], "app");
    }
}
