use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

use crate::store::now_secs;

pub const SESSION_TTL: u64 = 12 * 60 * 60;
pub const SESSION_COOKIE: &str = "ferry_session";

type HmacSha256 = Hmac<Sha256>;

fn sign(key: &str, payload: &str) -> Option<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    Some(mac.finalize().into_bytes().to_vec())
}

/// A signed, stateless session token: v1.<expiry>.<nonce>.<signature>.
pub fn issue_session(key: &str) -> Option<String> {
    let expires = now_secs() + SESSION_TTL;
    let nonce = Uuid::new_v4().simple().to_string();
    let payload = format!("v1.{expires}.{nonce}");
    let signature = URL_SAFE_NO_PAD.encode(sign(key, &payload)?);
    Some(format!("{payload}.{signature}"))
}

pub fn verify_session(key: &str, token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        return false;
    }
    let Ok(expires) = parts[1].parse::<u64>() else {
        return false;
    };
    let now = now_secs();
    if expires <= now || expires > now.saturating_add(SESSION_TTL + 300) {
        return false;
    }
    let payload = format!("v1.{}.{}", parts[1], parts[2]);
    let Ok(supplied) = URL_SAFE_NO_PAD.decode(parts[3]) else {
        return false;
    };
    let Some(expected) = sign(key, &payload) else {
        return false;
    };
    constant_time_eq(&supplied, &expected)
}

/// Constant-time comparison that also mixes in the length difference.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = (left.len() ^ right.len()) as u8;
    let length = left.len().max(right.len());
    for index in 0..length {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_and_verifies_sessions() {
        let key = "a-long-test-share-key";
        let token = issue_session(key).unwrap();
        assert!(verify_session(key, &token));
        assert!(!verify_session("another-key", &token));
        assert!(!verify_session(key, "v1.1.2.3"));
    }

    #[test]
    fn rejects_tampered_or_far_future_tokens() {
        let key = "a-long-test-share-key";
        let token = issue_session(key).unwrap();
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        parts[1] = (now_secs() + SESSION_TTL * 10).to_string();
        assert!(!verify_session(key, &parts.join(".")));
    }

    #[test]
    fn compares_without_early_exit() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"samf"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }
}
