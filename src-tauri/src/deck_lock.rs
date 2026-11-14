//! One lock per deck file: a change to a deck (its write, the version kept of it, the journal
//! entry about it) must not interleave with another change or history operation on the same
//! deck, or an app write would be recorded as an outside change. Commands run on several
//! threads; changes to different decks do not wait for each other.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// Whether a deck is being changed, and the signal that it no longer is.
#[derive(Default)]
struct Slot {
    held: Mutex<bool>,
    released: Condvar,
}

/// Holds a deck's lock until dropped.
pub struct Held(Arc<Slot>);

impl Drop for Held {
    fn drop(&mut self) {
        *self.0.held.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.0.released.notify_one();
    }
}

fn slots() -> &'static Mutex<HashMap<PathBuf, Arc<Slot>>> {
    static SLOTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Slot>>>> = OnceLock::new();
    SLOTS.get_or_init(Mutex::default)
}

/// Waits for the lock of deck `file` and takes it. It is not reentrant: what runs while it is
/// held must not take the same deck's lock again.
pub fn hold(file: &Path) -> Held {
    let key = file.canonicalize().unwrap_or_else(|_| file.into());
    let slot = slots()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_default()
        .clone();
    {
        let mut held = slot.held.lock().unwrap_or_else(|e| e.into_inner());
        while *held {
            held = slot.released.wait(held).unwrap_or_else(|e| e.into_inner());
        }
        *held = true;
    }
    Held(slot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn one_deck_is_held_by_one_thread_at_a_time() {
        let dir = TempDir::new("deck-lock");
        let file = dir.write("deck.html", "x");
        let inside = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..50 {
                        let _held = hold(&file);
                        assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0);
                        std::thread::yield_now();
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                });
            }
        });
    }

    #[test]
    fn decks_do_not_wait_for_each_other() {
        let dir = TempDir::new("deck-lock");
        let (a, b) = (dir.write("a.html", "a"), dir.write("b.html", "b"));
        let _a = hold(&a);
        // Would block forever if the two shared a lock.
        let _b = hold(&b);
        // A deck named by another spelling of its path is the same deck.
        let spelled = dir.join(".").join("a.html");
        let (sent, received) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            let _again = hold(&spelled);
            sent.send(()).unwrap();
        });
        assert!(received
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(_a);
        received
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        waiting.join().unwrap();
    }
}
