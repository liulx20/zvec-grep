//! Lossless path representation shared with the engine file codec.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(tag = "encoding", content = "value", rename_all = "snake_case")]
pub enum PathRecord {
    Utf8(String),
    UnixBytes(Vec<u8>),
    WindowsWide(Vec<u16>),
}

impl PathRecord {
    /// Encodes a native path losslessly.
    ///
    /// # Errors
    /// Rejects NUL and unsupported platform representations.
    pub fn from_path(path: &Path) -> Result<Self> {
        validate_path(path)?;
        if let Some(value) = path.to_str() {
            return Ok(Self::Utf8(value.to_owned()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            Ok(Self::UnixBytes(path.as_os_str().as_bytes().to_vec()))
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            Ok(Self::WindowsWide(path.as_os_str().encode_wide().collect()))
        }
        #[cfg(not(any(unix, windows)))]
        Err(Error::Storage(
            "cannot store a non-Unicode path on this platform".into(),
        ))
    }

    /// Decodes a native path.
    ///
    /// # Errors
    /// Rejects representations unavailable on this platform.
    pub fn into_path(self) -> Result<PathBuf> {
        match self {
            Self::Utf8(value) => Ok(PathBuf::from(value)),
            Self::UnixBytes(bytes) => {
                #[cfg(unix)]
                {
                    use std::os::unix::ffi::OsStringExt;
                    Ok(std::ffi::OsString::from_vec(bytes).into())
                }
                #[cfg(not(unix))]
                String::from_utf8(bytes).map(PathBuf::from).map_err(|_| {
                    Error::invalid_argument(
                        "stored Unix path cannot be represented on this platform",
                    )
                })
            }
            Self::WindowsWide(units) => {
                #[cfg(windows)]
                {
                    use std::os::windows::ffi::OsStringExt;
                    Ok(std::ffi::OsString::from_wide(&units).into())
                }
                #[cfg(not(windows))]
                String::from_utf16(&units).map(PathBuf::from).map_err(|_| {
                    Error::invalid_argument(
                        "stored Windows path cannot be represented on this platform",
                    )
                })
            }
        }
    }
}

fn validate_path(path: &Path) -> Result<()> {
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(Error::invalid_argument(
            "source file path must not contain NUL",
        ));
    }
    Ok(())
}

pub(crate) fn validate_relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        || path.as_os_str().as_encoded_bytes().contains(&0)
    {
        return Err(Error::invalid_argument(
            "source path must be a relative file or directory path within the workspace",
        ));
    }
    let normalized: PathBuf = path.components().collect();
    #[cfg(windows)]
    let same = normalized
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .map(|b| if *b == b'/' { b'\\' } else { *b })
        .eq(path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .map(|b| if *b == b'/' { b'\\' } else { *b }));
    #[cfg(not(windows))]
    let same = normalized.as_os_str() == path.as_os_str();
    if !same {
        return Err(Error::invalid_argument(
            "source path must use normalized native path components",
        ));
    }
    Ok(())
}
