use std::sync::{Arc, mpsc};

use tokio::sync::oneshot;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_SECRET_BYTES: usize = 2_048;
const VAULT_REFERENCE_PREFIX: &str = "vault:provider:";

trait CredentialStore: Send {
    fn set(&self, profile_id: &str, secret: &str) -> Result<(), String>;
    fn get(&self, profile_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, profile_id: &str) -> Result<(), String>;
}

#[cfg(target_os = "windows")]
struct WindowsCredentialStore {
    store: Arc<keyring_core::CredentialStore>,
}

#[cfg(target_os = "windows")]
impl WindowsCredentialStore {
    fn new() -> Result<Self, String> {
        let store = windows_native_keyring_store::Store::new()
            .map_err(|error| format!("Could not initialize Windows Credential Manager: {error}"))?;
        Ok(Self { store })
    }

    fn entry(&self, profile_id: &str) -> Result<keyring_core::Entry, String> {
        let target = format!("PimpCode/provider/{profile_id}");
        let modifiers = std::collections::HashMap::from([
            ("target", target.as_str()),
            ("persistence", "Local"),
        ]);
        self.store
            .build("Pimp Code provider profile", profile_id, Some(&modifiers))
            .map_err(|error| format!("Could not open the profile credential: {error}"))
    }
}

#[cfg(target_os = "windows")]
impl CredentialStore for WindowsCredentialStore {
    fn set(&self, profile_id: &str, secret: &str) -> Result<(), String> {
        self.entry(profile_id)?
            .set_password(secret)
            .map_err(|error| format!("Could not save the profile credential: {error}"))
    }

    fn get(&self, profile_id: &str) -> Result<Option<String>, String> {
        match self.entry(profile_id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("Could not read the profile credential: {error}")),
        }
    }

    fn delete(&self, profile_id: &str) -> Result<(), String> {
        match self.entry(profile_id)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not delete the profile credential: {error}")),
        }
    }
}

#[derive(Clone)]
pub struct CredentialVaultState {
    sender: mpsc::Sender<VaultRequest>,
}

enum VaultRequest {
    Set {
        profile_id: String,
        secret: Zeroizing<String>,
        respond: oneshot::Sender<Result<(), String>>,
    },
    Get {
        profile_id: String,
        respond: oneshot::Sender<Result<Option<Zeroizing<String>>, String>>,
    },
    Delete {
        profile_id: String,
        respond: oneshot::Sender<Result<(), String>>,
    },
}

fn run_vault_worker(store: Box<dyn CredentialStore>, receiver: mpsc::Receiver<VaultRequest>) {
    while let Ok(request) = receiver.recv() {
        match request {
            VaultRequest::Set {
                profile_id,
                secret,
                respond,
            } => {
                let _ = respond.send(store.set(&profile_id, secret.as_str()));
            }
            VaultRequest::Get {
                profile_id,
                respond,
            } => {
                let result = store
                    .get(&profile_id)
                    .map(|secret| secret.map(Zeroizing::new));
                let _ = respond.send(result);
            }
            VaultRequest::Delete {
                profile_id,
                respond,
            } => {
                let _ = respond.send(store.delete(&profile_id));
            }
        }
    }
}

impl CredentialVaultState {
    #[cfg(target_os = "windows")]
    pub fn native() -> Result<Self, String> {
        let store = Box::new(WindowsCredentialStore::new()?);
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("pimp-code-credential-vault".to_string())
            .spawn(move || run_vault_worker(store, receiver))
            .map_err(|error| format!("Could not start the credential-vault worker: {error}"))?;
        Ok(Self { sender })
    }

    #[cfg(not(target_os = "windows"))]
    pub fn native() -> Result<Self, String> {
        Err("The native credential vault is currently supported on Windows only".to_string())
    }

    pub async fn set(&self, profile_id: String, secret: String) -> Result<(), String> {
        validate_profile_id(&profile_id)?;
        validate_secret(&secret)?;
        let (respond, receive) = oneshot::channel();
        self.sender
            .send(VaultRequest::Set {
                profile_id,
                secret: Zeroizing::new(secret),
                respond,
            })
            .map_err(|_| "The credential-vault worker is unavailable".to_string())?;
        receive
            .await
            .map_err(|_| "The credential-vault worker stopped unexpectedly".to_string())?
    }

    pub async fn get(&self, profile_id: String) -> Result<Option<Zeroizing<String>>, String> {
        validate_profile_id(&profile_id)?;
        let (respond, receive) = oneshot::channel();
        self.sender
            .send(VaultRequest::Get {
                profile_id,
                respond,
            })
            .map_err(|_| "The credential-vault worker is unavailable".to_string())?;
        receive
            .await
            .map_err(|_| "The credential-vault worker stopped unexpectedly".to_string())?
    }

    pub async fn delete(&self, profile_id: String) -> Result<(), String> {
        validate_profile_id(&profile_id)?;
        let (respond, receive) = oneshot::channel();
        self.sender
            .send(VaultRequest::Delete {
                profile_id,
                respond,
            })
            .map_err(|_| "The credential-vault worker is unavailable".to_string())?;
        receive
            .await
            .map_err(|_| "The credential-vault worker stopped unexpectedly".to_string())?
    }
}

pub fn vault_reference(profile_id: &str) -> Result<String, String> {
    validate_profile_id(profile_id)?;
    Ok(format!("{VAULT_REFERENCE_PREFIX}{profile_id}"))
}

pub fn is_vault_reference_for_profile(reference: &str, profile_id: &str) -> bool {
    reference
        .strip_prefix(VAULT_REFERENCE_PREFIX)
        .is_some_and(|stored_id| stored_id == profile_id)
}

pub fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("The credential cannot be empty".to_string());
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err(format!(
            "The credential exceeds the {MAX_SECRET_BYTES}-byte limit"
        ));
    }
    if secret.chars().any(char::is_control) {
        return Err("The credential cannot contain control characters".to_string());
    }
    Ok(())
}

fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(profile_id)
        .map_err(|_| "The provider-profile ID is invalid".to_string())?;
    if parsed.to_string() != profile_id.to_ascii_lowercase() {
        return Err("The provider-profile ID must use canonical UUID form".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_profile_scoped_references() {
        let profile_id = "9ac14f43-e848-41b8-a0c1-036a47322d0c";
        let reference = vault_reference(profile_id).expect("vault reference");
        assert_eq!(
            reference,
            "vault:provider:9ac14f43-e848-41b8-a0c1-036a47322d0c"
        );
        assert!(is_vault_reference_for_profile(&reference, profile_id));
        assert!(!is_vault_reference_for_profile(
            &reference,
            "202af11c-66ae-4097-90ed-87dc54b07617"
        ));
    }

    #[test]
    fn rejects_secrets_that_are_empty_oversized_or_control_bearing() {
        assert!(validate_secret("").is_err());
        assert!(validate_secret(&"a".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert!(validate_secret("api-key\nsecond-line").is_err());
        assert!(validate_secret("api-key").is_ok());
    }
}
