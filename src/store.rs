use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Uploading,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub offset: u64,
    pub mime: String,
    pub status: FileStatus,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
pub struct NewUpload {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub fresh: bool,
}

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    Conflict { offset: u64 },
    Invalid(String),
    Io(io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(f, "file not found"),
            Self::Conflict { offset } => write!(f, "offset mismatch (server has {offset})"),
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

pub struct Store {
    root: PathBuf,
    meta_dir: PathBuf,
    blob_dir: PathBuf,
    write_lock: Mutex<()>,
}

impl Store {
    pub async fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        let meta_dir = root.join("meta");
        let blob_dir = root.join("blobs");
        fs::create_dir_all(&meta_dir).await?;
        fs::create_dir_all(&blob_dir).await?;
        set_mode(&root, 0o700).await?;
        set_mode(&meta_dir, 0o700).await?;
        set_mode(&blob_dir, 0o700).await?;

        let store = Self {
            root,
            meta_dir,
            blob_dir,
            write_lock: Mutex::new(()),
        };
        store.reconcile().await?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.meta_dir.join(format!("{id}.json"))
    }

    fn blob_path(&self, id: &str) -> PathBuf {
        self.blob_dir.join(format!("{id}.bin"))
    }

    fn valid_id(id: &str) -> bool {
        id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    async fn list_unlocked(&self) -> io::Result<Vec<FileMeta>> {
        let mut dir = fs::read_dir(&self.meta_dir).await?;
        let mut files = Vec::new();
        while let Some(entry) = dir.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            match fs::read(&path).await {
                Ok(bytes) => match serde_json::from_slice::<FileMeta>(&bytes) {
                    Ok(meta) => files.push(meta),
                    Err(error) => {
                        eprintln!("ferry: skipping unreadable metadata {path:?}: {error}");
                    }
                },
                Err(error) => {
                    eprintln!("ferry: skipping metadata {path:?}: {error}");
                }
            }
        }
        files.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.name.cmp(&b.name)));
        Ok(files)
    }

    pub async fn list(&self) -> io::Result<Vec<FileMeta>> {
        self.list_unlocked().await
    }

    pub async fn get(&self, id: &str) -> Result<FileMeta, StoreError> {
        if !Self::valid_id(id) {
            return Err(StoreError::NotFound);
        }
        let bytes = match fs::read(self.meta_path(id)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(StoreError::NotFound);
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        serde_json::from_slice(&bytes)
            .map_err(|error| StoreError::Invalid(format!("invalid metadata: {error}")))
    }

    pub async fn create_or_resume(&self, request: NewUpload) -> Result<FileMeta, StoreError> {
        let _guard = self.write_lock.lock().await;

        let name = clean_name(&request.name);
        let fingerprint = request
            .fingerprint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(200).collect::<String>())
            .unwrap_or_else(|| {
                format!(
                    "{}:{}:{}",
                    name,
                    request.size,
                    request.modified_at.unwrap_or_default()
                )
            });

        if !request.fresh {
            let existing = self.list_unlocked().await?;
            let mut incomplete = None;
            let mut complete = None;
            for meta in existing {
                if meta.fingerprint != fingerprint {
                    continue;
                }
                match meta.status {
                    FileStatus::Uploading if incomplete.is_none() => incomplete = Some(meta),
                    FileStatus::Complete if complete.is_none() => complete = Some(meta),
                    _ => {}
                }
            }
            if let Some(meta) = incomplete {
                return Ok(meta);
            }
            if let Some(meta) = complete {
                return Ok(meta);
            }
        }

        let id = Uuid::new_v4().simple().to_string();
        let now = now_secs();
        let mime = normalize_mime(request.mime.as_deref(), &name);
        let meta = FileMeta {
            id: id.clone(),
            name,
            size: request.size,
            offset: 0,
            mime,
            status: if request.size == 0 {
                FileStatus::Complete
            } else {
                FileStatus::Uploading
            },
            created_at: now,
            updated_at: now,
            modified_at: request.modified_at,
            fingerprint,
        };

        let blob = self.blob_path(&id);
        File::create(&blob).await?;
        set_mode(&blob, 0o600).await?;
        self.write_meta(&meta).await?;
        Ok(meta)
    }

    pub async fn append(
        &self,
        id: &str,
        offset: u64,
        data: &[u8],
    ) -> Result<FileMeta, StoreError> {
        let _guard = self.write_lock.lock().await;
        let mut meta = self.get(id).await?;

        if meta.status == FileStatus::Complete {
            return Err(StoreError::Conflict {
                offset: meta.offset,
            });
        }

        let blob_path = self.blob_path(id);
        let actual = match fs::metadata(&blob_path).await {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(StoreError::Io(error)),
        };

        // A crash can leave bytes on disk that are newer than the metadata.
        // Those bytes are still a valid prefix, so resume from the real size.
        if actual != meta.offset {
            if actual > meta.size {
                let file = OpenOptions::new().write(true).open(&blob_path).await?;
                file.set_len(meta.size).await?;
                file.sync_all().await?;
            }
            meta.offset = actual.min(meta.size);
            meta.status = if meta.offset == meta.size {
                FileStatus::Complete
            } else {
                FileStatus::Uploading
            };
            meta.updated_at = now_secs();
            self.write_meta(&meta).await?;
        }

        if offset != meta.offset {
            return Err(StoreError::Conflict {
                offset: meta.offset,
            });
        }
        if data.len() as u64 > meta.size.saturating_sub(meta.offset) {
            return Err(StoreError::Invalid(
                "chunk is larger than the remaining file".to_string(),
            ));
        }

        if !data.is_empty() {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&blob_path)
                .await
                .map_err(StoreError::Io)?;
            file.write_all(data).await?;
            file.sync_data().await?;
            meta.offset += data.len() as u64;
        }

        if meta.offset == meta.size {
            meta.status = FileStatus::Complete;
        }
        meta.updated_at = now_secs();
        self.write_meta(&meta).await?;
        Ok(meta)
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        if !Self::valid_id(id) {
            return Err(StoreError::NotFound);
        }
        let _guard = self.write_lock.lock().await;
        let meta_path = self.meta_path(id);
        match fs::remove_file(&meta_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(StoreError::NotFound);
            }
            Err(error) => return Err(StoreError::Io(error)),
        }
        match fs::remove_file(self.blob_path(id)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreError::Io(error)),
        }
    }

    pub async fn read_blob(&self, id: &str) -> Result<File, StoreError> {
        if !Self::valid_id(id) {
            return Err(StoreError::NotFound);
        }
        File::open(self.blob_path(id))
            .await
            .map_err(|error| StoreError::Io(error))
    }

    async fn write_meta(&self, meta: &FileMeta) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec_pretty(meta)
            .map_err(|error| StoreError::Invalid(format!("cannot serialize metadata: {error}")))?;
        let temporary = self
            .meta_dir
            .join(format!(".{}.json.tmp", meta.id));
        let final_path = self.meta_path(&meta.id);

        let mut file = File::create(&temporary).await?;
        set_mode(&temporary, 0o600).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&temporary, &final_path).await?;
        Ok(())
    }

    async fn reconcile(&self) -> io::Result<()> {
        let _guard = self.write_lock.lock().await;
        let files = self.list_unlocked().await?;
        for mut meta in files {
            if !Self::valid_id(&meta.id) {
                continue;
            }
            let blob_path = self.blob_path(&meta.id);
            let _ = set_mode(&self.meta_path(&meta.id), 0o600).await;
            let _ = set_mode(&blob_path, 0o600).await;
            let actual = match fs::metadata(&blob_path).await {
                Ok(metadata) => metadata.len(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
                Err(error) => return Err(error),
            };

            let clamped = actual.min(meta.size);
            if actual > meta.size {
                let file = OpenOptions::new().write(true).open(&blob_path).await?;
                file.set_len(meta.size).await?;
                file.sync_all().await?;
            }

            let next_status = if meta.size == 0 || clamped == meta.size {
                FileStatus::Complete
            } else {
                FileStatus::Uploading
            };
            if meta.offset != clamped || meta.status != next_status {
                meta.offset = clamped;
                meta.status = next_status;
                meta.updated_at = now_secs();
                if let Err(error) = self.write_meta(&meta).await {
                    eprintln!("ferry: could not repair metadata for {}: {error}", meta.id);
                }
            }
        }
        Ok(())
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(unix)]
async fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).await
}

#[cfg(not(unix))]
async fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

fn clean_name(raw: &str) -> String {
    let base = raw
        .rsplit(|character| character == '/' || character == '\\')
        .next()
        .unwrap_or(raw);
    let filtered: String = base
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{2069}'
                        | '\u{feff}'
                )
        })
        .collect();
    let trimmed = filtered
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    if trimmed.is_empty() {
        return "unnamed-file".to_string();
    }
    trimmed.chars().take(200).collect()
}

fn normalize_mime(raw: Option<&str>, name: &str) -> String {
    if let Some(value) = raw {
        if let Ok(parsed) = value.parse::<mime::Mime>() {
            return parsed.to_string();
        }
    }
    mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request(name: &str, size: u64) -> NewUpload {
        NewUpload {
            name: name.to_string(),
            size,
            mime: Some("application/octet-stream".to_string()),
            modified_at: Some(123),
            fingerprint: None,
            fresh: false,
        }
    }

    #[tokio::test]
    async fn creates_resumes_and_completes_an_upload() {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();

        let created = store.create_or_resume(request("hello.txt", 10)).await.unwrap();
        assert_eq!(created.offset, 0);
        assert_eq!(created.status, FileStatus::Uploading);

        let resumed = store.create_or_resume(request("hello.txt", 10)).await.unwrap();
        assert_eq!(resumed.id, created.id);

        let after_first = store.append(&created.id, 0, b"hello").await.unwrap();
        assert_eq!(after_first.offset, 5);

        let conflict = store
            .append(&created.id, 0, b"hello")
            .await
            .unwrap_err();
        match conflict {
            StoreError::Conflict { offset } => assert_eq!(offset, 5),
            other => panic!("unexpected error: {other}"),
        }

        let completed = store.append(&created.id, 5, b"world").await.unwrap();
        assert_eq!(completed.status, FileStatus::Complete);
        assert_eq!(completed.offset, 10);

        let downloaded = store.create_or_resume(request("hello.txt", 10)).await.unwrap();
        assert_eq!(downloaded.status, FileStatus::Complete);
    }

    #[tokio::test]
    async fn fresh_upload_gets_a_new_id() {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let first = store.create_or_resume(request("same.bin", 1)).await.unwrap();
        let mut second_request = request("same.bin", 1);
        second_request.fresh = true;
        let second = store.create_or_resume(second_request).await.unwrap();
        assert_ne!(first.id, second.id);
    }

    #[tokio::test]
    async fn zero_byte_files_are_complete_immediately() {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let meta = store.create_or_resume(request("empty", 0)).await.unwrap();
        assert_eq!(meta.status, FileStatus::Complete);
        assert_eq!(meta.offset, 0);
    }

    #[tokio::test]
    async fn reopens_and_repairs_metadata_from_the_blob_size() {
        let directory = tempdir().unwrap();
        let id;
        {
            let store = Store::open(directory.path()).await.unwrap();
            let meta = store.create_or_resume(request("partial.bin", 8)).await.unwrap();
            id = meta.id;
            store.append(&id, 0, b"1234").await.unwrap();
        }

        // Simulate a crash that persisted bytes but not the metadata update.
        let blob = directory.path().join("blobs").join(format!("{id}.bin"));
        let mut file = OpenOptions::new().append(true).open(&blob).await.unwrap();
        file.write_all(b"5678").await.unwrap();
        file.sync_all().await.unwrap();

        let store = Store::open(directory.path()).await.unwrap();
        let repaired = store.get(&id).await.unwrap();
        assert_eq!(repaired.offset, 8);
        assert_eq!(repaired.status, FileStatus::Complete);
    }

    #[tokio::test]
    async fn rejects_path_like_names_and_keeps_basename() {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let meta = store
            .create_or_resume(request("../../etc/passwd", 1))
            .await
            .unwrap();
        assert_eq!(meta.name, "passwd");
    }

    #[tokio::test]
    async fn invalid_ids_are_not_found() {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        assert!(matches!(store.get("../meta").await, Err(StoreError::NotFound)));
    }
}
