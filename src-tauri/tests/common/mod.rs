#![allow(dead_code)]
use scratchtree_lib::{model::*, store::Store};
pub fn item() -> Item {
    Item {
        id: String::new(),
        parent_id: None,
        kind: Kind::Note,
        markdown: String::new(),
        done: false,
        color: None,
        position: 0,
        created_at: 0,
        updated_at: 0,
        deleted_at: None,
        restore_parent_id: None,
        restore_index: None,
    }
}
/** Convenience test calls allocate explicit creation identities; production exposes only Item APIs. */
pub trait SeedStore {
    fn save(
        &mut self,
        id: Option<&str>,
        markdown: &str,
        key: &str,
        revision: i64,
        parent: Option<&str>,
    ) -> Result<WorkspaceSnapshot>;
    fn create_tree(&mut self, source: &str, parent: Option<&str>) -> Result<WorkspaceSnapshot>;
    fn rename_tree(&mut self, id: &str, source: &str) -> Result<WorkspaceSnapshot>;
}
impl SeedStore for Store {
    fn save(
        &mut self,
        id: Option<&str>,
        markdown: &str,
        key: &str,
        revision: i64,
        parent: Option<&str>,
    ) -> Result<WorkspaceSnapshot> {
        let draft = DraftAck {
            key: key.into(),
            revision,
        };
        if let Some(id) = id {
            self.save_source(id, markdown, &draft)
        } else {
            self.capture(&CaptureItem {
                id: uuid::Uuid::new_v4().to_string(),
                location: Location {
                    scope: Scope::Live,
                    item_id: parent.map(str::to_owned),
                },
                markdown: markdown.into(),
                draft,
            })
        }
    }
    fn create_tree(&mut self, source: &str, parent: Option<&str>) -> Result<WorkspaceSnapshot> {
        let id = uuid::Uuid::new_v4().to_string();
        self.create_child_tree(&CreateChildTree {
            id: id.clone(),
            parent: Location {
                scope: Scope::Live,
                item_id: parent.map(str::to_owned),
            },
            leave: None,
        })?;
        self.save_source(
            &id,
            source,
            &DraftAck {
                key: id.clone(),
                revision: 0,
            },
        )
    }
    fn rename_tree(&mut self, id: &str, source: &str) -> Result<WorkspaceSnapshot> {
        self.save_source(
            id,
            source,
            &DraftAck {
                key: id.into(),
                revision: 0,
            },
        )
    }
}
