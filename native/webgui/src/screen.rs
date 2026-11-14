//! Compact screen model built from the raw extractor output: short refs
//! (`f3`, `b7`, `t2`, `g1`) mapped to SAP GUI Scripting IDs for one screen.
use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawControl {
    pub sid: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub visible: bool,
    pub label: Option<String>,
    pub value: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub password: bool,
    #[serde(default)]
    pub readonly: bool,
    #[serde(default)]
    pub required: bool,
    pub checked: Option<bool>,
    pub selected: Option<bool>,
    #[serde(default)]
    pub disabled: bool,
    pub tooltip: Option<String>,
    pub fkey: Option<String>,
    pub columns: Option<Vec<String>>,
    #[serde(rename = "messageType")]
    pub message_type: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScrollInfo {
    pub first: Option<Value>,
    pub page: Option<Value>,
    pub total: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawScreen {
    pub page: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub sys: HashMap<String, String>,
    #[serde(default)]
    pub scroll: HashMap<String, ScrollInfo>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub controls: Vec<RawControl>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKind {
    Field,
    CheckBox,
    Radio,
    Combo,
    TextEdit,
    Button,
    Tab { strip: String },
    Table,
}

#[derive(Debug, Clone)]
pub struct Target {
    pub sid: String,
    pub dom_id: String,
    pub kind: TargetKind,
    pub name: String,
    pub text: String,
    pub fkey: Option<String>,
    pub readonly: bool,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub kind: &'static str,
    pub sid: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub first_row: Option<u64>,
    pub page_size: Option<u64>,
    pub total: Option<u64>,
}

pub struct Screen {
    pub page: String,
    pub title: String,
    pub tcode: String,
    pub program_screen: String,
    pub status: String,
    pub status_type: String,
    pub windows: Vec<String>,
    pub refs: BTreeMap<String, Target>,
    pub tables: BTreeMap<String, Table>,
    pub okcode_dom_id: Option<String>,
    raw_fields: Vec<Value>,
    raw_buttons: Vec<Value>,
    raw_tabs: Vec<Value>,
    texts: Vec<String>,
    sys: HashMap<String, String>,
    other_text: Option<String>,
}

const CELL_PREFIXES: &[&str] = &["ctxt", "txt", "pwd", "cmb", "chk", "rad", "lbl", "btn", "tabs", "tabp", "tbl", "ssub", "sub", "cntl", "okcd", "shell"];

/// DDIC-style name from the last SID segment: `wnd[0]/usr/ctxtBTCH2170-USERNAME` → `BTCH2170-USERNAME`.
pub fn field_name(sid: &str) -> String {
    let last = sid.rsplit('/').next().unwrap_or(sid);
    let last = last.split('[').next().unwrap_or(last);
    for prefix in CELL_PREFIXES {
        if let Some(rest) = last.strip_prefix(prefix)
            && !rest.is_empty()
            && !rest.starts_with(|c: char| c.is_ascii_lowercase())
        {
            return rest.to_owned();
        }
    }
    last.to_owned()
}

/// `…[c,r]` suffix → (prefix, c, r).
fn cell_coords(sid: &str) -> Option<(&str, u32, u32)> {
    let open = sid.rfind('[')?;
    let inner = sid[open + 1..].strip_suffix(']')?;
    let (c, r) = inner.split_once(',')?;
    Some((&sid[..open], c.trim().parse().ok()?, r.trim().parse().ok()?))
}

/// `…/rowcol/row[r]/cell[c]` → (grid sid, r, c).
fn grid_coords(sid: &str) -> Option<(&str, u32, u32)> {
    let (grid, rest) = sid.split_once("/rowcol/row[")?;
    let (r, rest) = rest.split_once(']')?;
    let c = rest.strip_prefix("/cell[")?.strip_suffix(']')?;
    Some((grid, r.parse().ok()?, c.parse().ok()?))
}

fn as_u64(value: &Option<Value>) -> Option<u64> {
    match value.as_ref()? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn place(line: &mut String, col: usize, text: &str) {
    let len = line.chars().count();
    if len < col {
        line.extend(std::iter::repeat_n(' ', col - len));
    } else if len > 0 && !line.ends_with(' ') && !text.is_empty() {
        line.push(' ');
    }
    line.push_str(text);
}

pub fn build(raw: RawScreen) -> Screen {
    let sys = raw.sys;
    let mut screen = Screen {
        page: raw.page.clone(),
        title: raw.title.clone(),
        tcode: sys.get("MBAR_TRANSACTION").cloned().unwrap_or_default(),
        program_screen: sys.get("MBAR_DYNPRO").cloned().unwrap_or_default(),
        status: raw.status.clone(),
        status_type: String::new(),
        windows: Vec::new(),
        refs: BTreeMap::new(),
        tables: BTreeMap::new(),
        okcode_dom_id: None,
        raw_fields: Vec::new(),
        raw_buttons: Vec::new(),
        raw_tabs: Vec::new(),
        texts: Vec::new(),
        sys: sys.clone(),
        other_text: raw.text.clone(),
    };
    let controls = raw.controls;
    for c in &controls {
        if let Some(w) = c.sid.split('/').next().filter(|w| w.starts_with("wnd[")) {
            let w = w.to_owned();
            if !screen.windows.contains(&w) {
                screen.windows.push(w);
            }
        }
        if c.kind == "MESSAGEBAR" {
            screen.status_type = c.message_type.clone().unwrap_or_default();
        }
    }
    // Tables first so their cells are not listed as fields.
    let mut table_sids: Vec<(String, &'static str, Vec<String>)> = Vec::new();
    for c in &controls {
        match c.kind.as_str() {
            "ABAPLIST" => table_sids.push((c.sid.clone(), "list", Vec::new())),
            "GuiGridView" => table_sids.push((c.sid.clone(), "grid", c.columns.clone().unwrap_or_default())),
            "GuiTableControl" => table_sids.push((c.sid.clone(), "table_control", Vec::new())),
            _ => {}
        }
    }
    let is_cell = |sid: &str| grid_coords(sid).is_some() || cell_coords(sid).is_some_and(|(p, _, _)| table_sids.iter().any(|(t, _, _)| p.starts_with(t.as_str())));
    let (mut nf, mut nb, mut nt) = (0, 0, 0);
    for c in &controls {
        if !c.visible || is_cell(&c.sid) {
            continue;
        }
        let name = field_name(&c.sid);
        let label = c.label.clone().unwrap_or_default();
        let kind = match c.kind.as_str() {
            "GuiOKCodeField" => {
                screen.okcode_dom_id = Some(c.id.clone());
                continue;
            }
            "GuiTextField" | "GuiCTextField" | "GuiPasswordField" => Some(TargetKind::Field),
            "GuiComboBox" => Some(TargetKind::Combo),
            "GuiCheckBox" => Some(TargetKind::CheckBox),
            "GuiRadioButton" => Some(TargetKind::Radio),
            "GuiTextedit" | "GuiTextEdit" => Some(TargetKind::TextEdit),
            _ => None,
        };
        if let Some(kind) = kind {
            nf += 1;
            let r = format!("f{nf}");
            let mut f = json!({ "ref": r, "sid": c.sid, "name": name, "label": label });
            match kind {
                TargetKind::CheckBox | TargetKind::Radio => f["checked"] = json!(c.checked.unwrap_or(false)),
                _ if c.password => f["password"] = json!(true),
                _ => f["value"] = json!(c.value.clone().or_else(|| c.text.clone()).unwrap_or_default()),
            }
            if c.readonly || c.disabled {
                f["readonly"] = json!(true);
            }
            if c.required {
                f["required"] = json!(true);
            }
            if kind != TargetKind::Field {
                f["type"] = json!(match kind {
                    TargetKind::Combo => "combo",
                    TargetKind::CheckBox => "checkbox",
                    TargetKind::Radio => "radio",
                    _ => "textedit",
                });
            }
            screen.raw_fields.push(f);
            screen.refs.insert(r, Target { sid: c.sid.clone(), dom_id: c.id.clone(), kind, name, text: label, fkey: None, readonly: c.readonly || c.disabled });
            continue;
        }
        match c.kind.as_str() {
            "GuiButton" => {
                let text = c.text.clone().unwrap_or_default();
                let tooltip = c.tooltip.clone().unwrap_or_default();
                if text.is_empty() && tooltip.is_empty() {
                    continue;
                }
                nb += 1;
                let r = format!("b{nb}");
                let mut b = json!({ "ref": r, "sid": c.sid });
                if !text.is_empty() {
                    b["text"] = json!(text);
                }
                if !tooltip.is_empty() && tooltip != text {
                    b["tooltip"] = json!(tooltip);
                }
                if let Some(fkey) = &c.fkey {
                    b["fkey"] = json!(fkey);
                }
                if c.disabled {
                    b["disabled"] = json!(true);
                }
                screen.raw_buttons.push(b);
                let words = format!("{text} {tooltip}").trim().to_owned();
                screen.refs.insert(r, Target { sid: c.sid.clone(), dom_id: c.id.clone(), kind: TargetKind::Button, name, text: words, fkey: c.fkey.clone(), readonly: c.disabled });
            }
            "GuiTab" => {
                let strip_sid = c.sid.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                let Some(strip) = controls.iter().find(|s| s.sid == strip_sid) else { continue };
                nt += 1;
                let r = format!("t{nt}");
                let text = c.text.clone().or_else(|| c.label.clone()).unwrap_or_default();
                screen.raw_tabs.push(json!({ "ref": r, "sid": c.sid, "text": text, "selected": c.selected.unwrap_or(false) }));
                screen.refs.insert(r, Target { sid: c.sid.clone(), dom_id: c.id.clone(), kind: TargetKind::Tab { strip: strip.id.clone() }, name, text, fkey: None, readonly: false });
            }
            "GuiLabel" => {
                if let Some(t) = c.text.as_ref().filter(|t| !t.is_empty()) {
                    screen.texts.push(t.clone());
                }
            }
            _ => {}
        }
    }
    for (i, (sid, kind, columns)) in table_sids.into_iter().enumerate() {
        let r = format!("g{}", i + 1);
        let table = build_table(&controls, &sid, kind, columns, &raw.scroll);
        screen.refs.insert(r.clone(), Target { sid: sid.clone(), dom_id: String::new(), kind: TargetKind::Table, name: field_name(&sid), text: kind.into(), fkey: None, readonly: true });
        screen.tables.insert(r, table);
    }
    screen
}

fn build_table(controls: &[RawControl], sid: &str, kind: &'static str, mut columns: Vec<String>, scroll: &HashMap<String, ScrollInfo>) -> Table {
    let mut rows: BTreeMap<u32, BTreeMap<u32, String>> = BTreeMap::new();
    let mut names: BTreeMap<u32, String> = BTreeMap::new();
    for c in controls {
        let cell_text = || {
            if let Some(checked) = c.checked.filter(|_| c.sid.contains("/chk")) {
                return if checked { "[x]".to_owned() } else { "[ ]".to_owned() };
            }
            c.value.clone().or_else(|| c.text.clone()).unwrap_or_default()
        };
        match kind {
            "grid" => {
                if let Some((g, r, col)) = grid_coords(&c.sid).filter(|(g, _, _)| *g == sid) {
                    let _ = g;
                    rows.entry(r).or_default().insert(col, cell_text());
                }
            }
            _ => {
                if let Some((prefix, col, r)) = cell_coords(&c.sid).filter(|(p, _, _)| p.starts_with(sid) && *p != sid) {
                    if kind == "table_control" {
                        names.entry(col).or_insert_with(|| field_name(prefix));
                    }
                    rows.entry(r).or_default().insert(col, cell_text());
                }
            }
        }
    }
    let table_rows: Vec<Vec<String>> = if kind == "list" {
        rows.values()
            .map(|cells| {
                let mut line = String::new();
                for (col, text) in cells {
                    place(&mut line, *col as usize, text);
                }
                vec![line.trim_end().to_owned()]
            })
            .collect()
    } else {
        let width = rows.values().filter_map(|r| r.keys().max()).max().map(|m| *m as usize + 1).unwrap_or(0);
        // Grids and table controls render empty filler rows below the data.
        rows.values()
            .filter(|cells| cells.values().any(|v| !v.trim().is_empty()))
            .map(|cells| (0..width as u32).map(|c| cells.get(&c).cloned().unwrap_or_default()).collect())
            .collect()
    };
    if kind == "table_control" {
        columns = names.into_values().collect();
    }
    let info = if kind == "list" { scroll.iter().find(|(k, _)| k.starts_with("userarealist")).map(|(_, v)| v) } else { None };
    Table {
        kind,
        sid: sid.to_owned(),
        columns,
        rows: table_rows,
        first_row: info.and_then(|i| as_u64(&i.first)),
        page_size: info.and_then(|i| as_u64(&i.page)),
        total: info.and_then(|i| as_u64(&i.total)),
    }
}

impl Screen {
    pub fn table_json(&self, r: &str, table: &Table, from: usize, count: usize) -> Value {
        let rows: Vec<&Vec<String>> = table.rows.iter().skip(from).take(count).collect();
        let mut v = json!({
            "ref": r,
            "kind": table.kind,
            "sid": table.sid,
            "rendered_rows": table.rows.len(),
            "from": from,
            "rows": rows,
        });
        if !table.columns.is_empty() {
            v["columns"] = json!(table.columns);
        }
        if let Some(total) = table.total {
            v["total_rows"] = json!(total);
        }
        if let Some(first) = table.first_row {
            v["first_visible_row"] = json!(first);
        }
        if let Some(page) = table.page_size {
            v["page_size"] = json!(page);
        }
        v
    }

    /// The model returned to the host; `table_rows` caps rows per table.
    pub fn to_json(&self, table_rows: usize) -> Value {
        if self.page != "webgui" {
            return json!({ "page": self.page, "title": self.title, "text": self.other_text });
        }
        let tables: Vec<Value> = self.tables.iter().map(|(r, t)| self.table_json(r, t, 0, table_rows)).collect();
        let mut v = json!({
            "title": self.title,
            "tcode": self.tcode,
            "screen": self.program_screen,
            "system": self.sys.get("MBAR_SYSTEM").cloned().unwrap_or_default(),
            "user": self.sys.get("MBAR_USER").cloned().unwrap_or_default(),
            "windows": self.windows,
            "status": { "type": self.status_type, "text": self.status },
            "fields": self.raw_fields,
            "buttons": self.raw_buttons,
        });
        if !self.raw_tabs.is_empty() {
            v["tabs"] = json!(self.raw_tabs);
        }
        if !tables.is_empty() {
            v["tables"] = json!(tables);
        }
        if !self.texts.is_empty() {
            v["texts"] = json!(self.texts.iter().take(60).collect::<Vec<_>>());
        }
        v
    }

    /// Resolves a ref (`f3`), a full SID, a DDIC field name (`BTCH2170-USERNAME`),
    /// or a button/tab by its visible text (`Search`); names and texts must be unique.
    pub fn resolve(&self, key: &str) -> Option<&Target> {
        if let Some(t) = self.refs.get(key) {
            return Some(t);
        }
        let unique = |pred: &dyn Fn(&Target) -> bool| {
            let mut matches = self.refs.values().filter(|t| t.kind != TargetKind::Table && pred(t));
            let first = matches.next()?;
            matches.next().is_none().then_some(first)
        };
        let lower = key.to_lowercase();
        self.refs
            .values()
            .find(|t| t.sid == key)
            .or_else(|| unique(&|t| t.name.eq_ignore_ascii_case(key)))
            .or_else(|| {
                unique(&|t| {
                    matches!(t.kind, TargetKind::Button | TargetKind::Tab { .. })
                        && (t.text.to_lowercase() == lower || t.text.to_lowercase().starts_with(&format!("{lower} ")))
                })
            })
    }

    pub fn summary(&self) -> String {
        if self.page != "webgui" {
            return format!("page {} ({})", self.page, self.title);
        }
        format!("{} {} \"{}\"", self.tcode, self.program_screen, self.title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(sid: &str, kind: &str, id: &str) -> RawControl {
        RawControl { sid: sid.into(), kind: kind.into(), id: id.into(), visible: true, ..Default::default() }
    }

    #[test]
    fn names_come_from_scripting_ids() {
        assert_eq!(field_name("wnd[0]/usr/ctxtBTCH2170-USERNAME"), "BTCH2170-USERNAME");
        assert_eq!(field_name("wnd[0]/tbar[1]/btn[7]"), "btn");
        assert_eq!(field_name("wnd[0]/usr/tabsTABSTRIP1/tabpLOGO"), "LOGO");
        assert_eq!(field_name("wnd[0]/usr/tblSAPLSE16NSELFIELDS_TC/txtGS_SELFIELDS-SCRTEXT_M[0,1]"), "GS_SELFIELDS-SCRTEXT_M");
    }

    #[test]
    fn builds_fields_buttons_tabs_and_abap_list_lines() {
        let mut user = control("wnd[0]/usr/ctxtSUID_ST_BNAME-BNAME", "GuiCTextField", "M0:1");
        user.value = Some("EMSDI0845".into());
        user.label = Some("User".into());
        let mut display = control("wnd[0]/tbar[1]/btn[7]", "GuiButton", "M0:2");
        display.text = Some("Display".into());
        display.fkey = Some("F7".into());
        let strip = control("wnd[0]/usr/tabsTABSTRIP1", "GuiTabStrip", "TS1");
        let mut tab = control("wnd[0]/usr/tabsTABSTRIP1/tabpLOGO", "GuiTab", "TS1-tab2");
        tab.text = Some("Logon Data".into());
        let list = control("wnd[0]/usr", "ABAPLIST", "userarealist0");
        let mut a = control("wnd[0]/usr/lbl[0,3]", "undefined", "c1");
        a.text = Some("JOB_A".into());
        let mut b = control("wnd[0]/usr/lbl[34,3]", "undefined", "c2");
        b.text = Some("Finished".into());
        let mut chk = control("wnd[0]/usr/chk[0,4]", "ABAPLISTCHECKBOX", "c3");
        chk.checked = Some(true);
        let mut okcd = control("wnd[0]/tbar[0]/okcd", "GuiOKCodeField", "ToolbarOkCode");
        okcd.value = Some(String::new());
        let mut scroll = HashMap::new();
        scroll.insert("userarealist0-scrollV".into(), ScrollInfo { first: Some(json!(0)), page: Some(json!(18)), total: Some(json!("127448")) });
        let raw = RawScreen {
            page: "webgui".into(),
            title: "Display Users".into(),
            sys: [("MBAR_TRANSACTION".to_owned(), "SU01D".to_owned()), ("MBAR_DYNPRO".to_owned(), "SAPLSUID_MAINTENANCE/1100".to_owned())].into(),
            scroll,
            controls: vec![user, display, strip, tab, okcd, list, a, b, chk],
            ..Default::default()
        };
        let screen = build(raw);
        let v = screen.to_json(10);
        assert_eq!(v["tcode"], "SU01D");
        assert_eq!(v["fields"][0]["value"], "EMSDI0845");
        assert_eq!(v["buttons"][0]["fkey"], "F7");
        assert_eq!(v["tabs"][0]["text"], "Logon Data");
        assert_eq!(v["tables"][0]["kind"], "list");
        assert_eq!(v["tables"][0]["rows"][0][0], format!("JOB_A{}Finished", " ".repeat(29)));
        assert_eq!(v["tables"][0]["rows"][1][0], "[x]");
        assert_eq!(v["tables"][0]["total_rows"], 127448);
        assert_eq!(screen.okcode_dom_id.as_deref(), Some("ToolbarOkCode"));
        assert_eq!(screen.resolve("SUID_ST_BNAME-BNAME").unwrap().dom_id, "M0:1");
        assert!(matches!(&screen.resolve("t1").unwrap().kind, TargetKind::Tab { strip } if strip == "TS1"));
    }

    #[test]
    fn grid_cells_group_by_row_with_column_ids() {
        let mut grid = control("wnd[0]/shellcont/shell", "GuiGridView", "C115");
        grid.columns = Some(vec!["MANDT".into(), "MTEXT".into()]);
        let mut c00 = control("wnd[0]/shellcont/shell/rowcol/row[0]/cell[0]", "", "x");
        c00.text = Some("100".into());
        let mut c01 = control("wnd[0]/shellcont/shell/rowcol/row[0]/cell[1]", "", "y");
        c01.text = Some("Production".into());
        let raw = RawScreen { page: "webgui".into(), controls: vec![grid, c00, c01], ..Default::default() };
        let v = build(raw).to_json(5);
        assert_eq!(v["tables"][0]["columns"], json!(["MANDT", "MTEXT"]));
        assert_eq!(v["tables"][0]["rows"][0], json!(["100", "Production"]));
        assert!(v["fields"].as_array().unwrap().is_empty());
    }
}
