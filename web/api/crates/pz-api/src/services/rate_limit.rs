//! A small fixed-window attempt limiter, used to slow down password guessing.
//!
//! Keyed by username rather than client address: the API sits behind nginx, so
//! the peer address is the proxy's, and trusting `X-Forwarded-For` needs a
//! trusted-proxy list this stack does not have yet. Per-username limiting is
//! what actually protects an individual account from being ground through a
//! wordlist; add per-address limiting at the edge alongside it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Ceiling on tracked keys. An attacker cycling through invented usernames
/// would otherwise grow this map without limit.
const MAX_TRACKED_KEYS: usize = 10_000;

pub struct AttemptLimiter {
    max_attempts: usize,
    window: Duration,
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
}

impl AttemptLimiter {
    pub fn new(max_attempts: usize, window: Duration) -> Self {
        Self {
            max_attempts,
            window,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Whether another attempt is allowed for this key right now.
    pub fn is_allowed(&self, key: &str) -> bool {
        let mut attempts = self.lock();
        let Some(recent) = attempts.get_mut(&normalise(key)) else {
            return true;
        };

        let cutoff = Instant::now() - self.window;
        recent.retain(|at| *at > cutoff);

        recent.len() < self.max_attempts
    }

    /// Record a failed attempt.
    pub fn record_failure(&self, key: &str) {
        let mut attempts = self.lock();

        if attempts.len() >= MAX_TRACKED_KEYS {
            prune(&mut attempts, self.window);

            // Still full: drop everything rather than grow without bound. This
            // forgives attempts in flight, which beats exhausting memory.
            if attempts.len() >= MAX_TRACKED_KEYS {
                tracing::warn!("attempt limiter is full; clearing tracked keys");
                attempts.clear();
            }
        }

        attempts
            .entry(normalise(key))
            .or_default()
            .push(Instant::now());
    }

    /// Forget a key. Called on a successful login so one bad night does not
    /// keep locking someone out.
    pub fn clear(&self, key: &str) {
        self.lock().remove(&normalise(key));
    }

    /// A poisoned lock means another thread panicked while holding it. The map
    /// is still structurally sound, and refusing every login afterwards would
    /// be a worse outcome than carrying on.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Instant>>> {
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn normalise(key: &str) -> String {
    key.trim().to_lowercase()
}

fn prune(attempts: &mut HashMap<String, Vec<Instant>>, window: Duration) {
    let cutoff = Instant::now() - window;

    attempts.retain(|_, recent| {
        recent.retain(|at| *at > cutoff);
        !recent.is_empty()
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> AttemptLimiter {
        AttemptLimiter::new(3, Duration::from_secs(60))
    }

    #[test]
    fn allows_attempts_up_to_the_limit() {
        let limiter = limiter();

        for _ in 0..3 {
            assert!(limiter.is_allowed("giorgi"));
            limiter.record_failure("giorgi");
        }

        assert!(!limiter.is_allowed("giorgi"));
    }

    #[test]
    fn limits_are_per_key() {
        let limiter = limiter();

        for _ in 0..3 {
            limiter.record_failure("giorgi");
        }

        assert!(!limiter.is_allowed("giorgi"));
        assert!(limiter.is_allowed("nino"));
    }

    #[test]
    fn keys_are_case_insensitive_like_the_username_lookup() {
        let limiter = limiter();

        for _ in 0..3 {
            limiter.record_failure("Giorgi");
        }

        assert!(!limiter.is_allowed("giorgi"));
        assert!(!limiter.is_allowed("  GIORGI  "));
    }

    #[test]
    fn a_successful_login_clears_the_record() {
        let limiter = limiter();

        for _ in 0..3 {
            limiter.record_failure("giorgi");
        }
        limiter.clear("giorgi");

        assert!(limiter.is_allowed("giorgi"));
    }

    #[test]
    fn attempts_outside_the_window_stop_counting() {
        let limiter = AttemptLimiter::new(3, Duration::from_millis(30));

        for _ in 0..3 {
            limiter.record_failure("giorgi");
        }
        assert!(!limiter.is_allowed("giorgi"));

        std::thread::sleep(Duration::from_millis(50));

        assert!(limiter.is_allowed("giorgi"));
    }

    #[test]
    fn pruning_drops_keys_whose_attempts_have_all_expired() {
        let mut attempts = HashMap::new();
        attempts.insert(
            "old".to_owned(),
            vec![Instant::now() - Duration::from_secs(120)],
        );
        attempts.insert("fresh".to_owned(), vec![Instant::now()]);

        prune(&mut attempts, Duration::from_secs(60));

        assert!(!attempts.contains_key("old"));
        assert!(attempts.contains_key("fresh"));
    }
}
