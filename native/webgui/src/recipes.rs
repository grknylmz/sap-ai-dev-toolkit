//! Curated read-only recipes embedded in the binary (TOML). Each step checks
//! a screen guard before acting; a mismatch stops the recipe and returns the
//! current screen instead of improvising.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::session::Session;

// Each recipe was verified live on SAP S/4HANA 2023 (SAP_BASIS 758) WebGUI.
const SOURCES: &[&str] = &[
    include_str!("recipes/sm37_jobs.toml"),
    include_str!("recipes/st22_dumps.toml"),
    include_str!("recipes/su53_auth_check.toml"),
    include_str!("recipes/su01d_user.toml"),
    include_str!("recipes/se16n_table.toml"),
    include_str!("recipes/al11_directories.toml"),
    include_str!("recipes/sm12_locks.toml"),
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    /// Expected `PROGRAM/DYNPRO` before the step acts; `|` separates alternatives.
    #[serde(default)]
    pub expect: Option<String>,
    /// Fields by DDIC name, SID or ref; values may use `{param}`; empty values are skipped.
    #[serde(default)]
    pub set: BTreeMap<String, String>,
    /// Tab (field name of the tab SID, e.g. `LOGO`) to select.
    #[serde(default)]
    pub tab: Option<String>,
    /// Button to press by SID, field name, or visible text (e.g. `Search`).
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub fkey: Option<String>,
    #[serde(default)]
    pub okcode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub name: String,
    pub title: String,
    pub description: String,
    pub tcode: String,
    /// Cheaper ADT route for the same data (shown to the host).
    #[serde(default)]
    pub prefer: Option<String>,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub steps: Vec<Step>,
    /// Expected final screen.
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default = "default_rows")]
    pub rows: usize,
}

fn default_rows() -> usize {
    60
}

pub fn all() -> Vec<Recipe> {
    SOURCES.iter().map(|s| toml::from_str(s).expect("embedded recipe is valid TOML")).collect()
}

pub fn listing() -> Value {
    Value::Array(
        all()
            .into_iter()
            .map(|r| {
                let params: Vec<Value> = r.params.iter().map(|p| json!({ "name": p.name, "description": p.description, "default": p.default, "required": p.required })).collect();
                let mut v = json!({ "name": r.name, "title": r.title, "tcode": r.tcode, "description": r.description, "params": params });
                if let Some(prefer) = &r.prefer {
                    v["prefer"] = json!(prefer);
                }
                v
            })
            .collect(),
    )
}

fn substitute(template: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..].find('}').ok_or_else(|| format!("unclosed placeholder in {template:?}"))? + start;
        let name = &rest[start + 1..end];
        out.push_str(values.get(name).ok_or_else(|| format!("recipe uses unknown parameter {name}"))?);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn guard_matches(expect: &str, actual: &str) -> bool {
    expect.split('|').map(str::trim).any(|e| e.eq_ignore_ascii_case(actual))
}

pub fn resolve_params(recipe: &Recipe, given: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    if let Some(unknown) = given.keys().find(|k| !recipe.params.iter().any(|p| &p.name == *k)) {
        return Err(format!("recipe {} has no parameter {unknown}; parameters: {}", recipe.name, recipe.params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")));
    }
    let mut values = BTreeMap::new();
    for p in &recipe.params {
        let value = given.get(&p.name).cloned().or_else(|| p.default.clone()).unwrap_or_default();
        if p.required && value.trim().is_empty() {
            return Err(format!("recipe {} needs parameter {} ({})", recipe.name, p.name, p.description));
        }
        values.insert(p.name.clone(), value);
    }
    Ok(values)
}

pub async fn run(session: &mut Session, name: &str, given: &BTreeMap<String, String>) -> Result<Value, String> {
    let recipes = all();
    let recipe = recipes.iter().find(|r| r.name.eq_ignore_ascii_case(name)).ok_or_else(|| {
        format!("no recipe {name:?}; available: {}", recipes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", "))
    })?;
    let values = resolve_params(recipe, given)?;
    session.start_transaction(&recipe.tcode, &BTreeMap::new(), None).await?;
    for (index, step) in recipe.steps.iter().enumerate() {
        let screen = session.screen().await?;
        if let Some(expect) = &step.expect
            && !guard_matches(expect, &screen.program_screen)
        {
            return Err(format!(
                "recipe {} stopped at step {}: expected screen {expect}, found {}. Status: {} — continue with the generic webgui_* tools.\n{}",
                recipe.name,
                index + 1,
                screen.summary(),
                screen.status,
                screen.to_json(10)
            ));
        }
        let mut set = BTreeMap::new();
        for (field, template) in &step.set {
            let value = substitute(template, &values)?;
            if !value.is_empty() {
                set.insert(field.clone(), value);
            }
        }
        if !set.is_empty() {
            session.set_fields(&set).await?;
        }
        if let Some(tab) = &step.tab {
            session.press_ref(tab).await?;
        }
        if let Some(button) = &step.button {
            session.press_ref(button).await?;
        }
        if let Some(fkey) = &step.fkey {
            session.press_fkey(fkey).await?;
        }
        if let Some(okcode) = &step.okcode {
            crate::guard::check_okcode(okcode)?;
            session.enter_okcode(&substitute(okcode, &values)?).await?;
        }
    }
    let screen = session.screen().await?;
    if let Some(expect) = &recipe.result
        && !guard_matches(expect, &screen.program_screen)
    {
        return Err(format!(
            "recipe {} ended on {} instead of {expect}. Status: {}\n{}",
            recipe.name,
            screen.summary(),
            if screen.status.is_empty() { "(none)" } else { &screen.status },
            screen.to_json(10)
        ));
    }
    let mut result = json!({ "recipe": recipe.name, "params": values, "screen": screen.to_json(recipe.rows) });
    if let Some(prefer) = &recipe.prefer {
        result["prefer"] = json!(prefer);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_recipes_parse_and_pass_the_read_only_guard() {
        let recipes = all();
        assert_eq!(recipes.len(), 7);
        for recipe in &recipes {
            crate::guard::check_tcode(&recipe.tcode).unwrap_or_else(|e| panic!("{}: {e}", recipe.name));
            for step in &recipe.steps {
                if let Some(okcode) = &step.okcode {
                    crate::guard::check_okcode(okcode).unwrap_or_else(|e| panic!("{}: {e}", recipe.name));
                }
                if let Some(fkey) = &step.fkey {
                    crate::guard::check_fkey(fkey).unwrap();
                }
                let values: BTreeMap<String, String> = recipe.params.iter().map(|p| (p.name.clone(), "x".to_owned())).collect();
                for template in step.set.values() {
                    substitute(template, &values).unwrap_or_else(|e| panic!("{}: {e}", recipe.name));
                }
            }
        }
    }

    #[test]
    fn substitutes_parameters() {
        let values: BTreeMap<String, String> = [("user".to_owned(), "DEV1".to_owned())].into();
        assert_eq!(substitute("{user}", &values).unwrap(), "DEV1");
        assert!(substitute("{nope}", &values).is_err());
    }
}
