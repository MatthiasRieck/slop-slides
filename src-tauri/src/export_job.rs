//! An export under way, as the window that asked for it follows it: how far it has got
//! ([`Job::step`], which the Export button shows as "Slide 4 of 20") and whether the user has
//! called it off ([`cancel`]). An export checks at every step, before it writes its file, so a
//! cancelled one leaves nothing behind. The video export has its own (see video/).

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::error::{Error, Result};

/// The error an export the user cancelled ends with.
pub const CANCELLED: &str = "the export was cancelled";
/// The event that carries a [`Progress`] to the window.
pub const PROGRESS_EVENT: &str = "export-progress";

/// How far an export has got: `done` of `total` slides.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// The export it is about, as the frontend named it.
    pub job: String,
    pub done: usize,
    pub total: usize,
}

/// The exports the user has cancelled that have not ended yet.
static CANCELLED_JOBS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// The exports running.
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn locked(
    set: &'static Mutex<Option<HashSet<String>>>,
) -> MutexGuard<'static, Option<HashSet<String>>> {
    set.lock().unwrap_or_else(|e| e.into_inner())
}

/// Stops the export `job` at its next step, if it runs; it ends with [`CANCELLED`].
pub fn cancel(job: &str) {
    if locked(&RUNNING).as_ref().is_some_and(|r| r.contains(job)) {
        locked(&CANCELLED_JOBS)
            .get_or_insert_with(HashSet::new)
            .insert(job.to_string());
    }
}

/// One export, from its start to its end.
pub struct Job {
    id: String,
    report: Box<dyn Fn(Progress) + Send + Sync>,
}

impl Job {
    /// The export the frontend calls `id`, telling `report` how far it has got.
    pub fn start(id: impl Into<String>, report: impl Fn(Progress) + Send + Sync + 'static) -> Job {
        let id = id.into();
        locked(&RUNNING)
            .get_or_insert_with(HashSet::new)
            .insert(id.clone());
        Job {
            id,
            report: Box::new(report),
        }
    }

    /// An export nobody follows or cancels: one the agent asked for.
    pub fn unattended() -> Job {
        Job::start(uuid::Uuid::new_v4().simple().to_string(), |_| {})
    }

    /// Fails with [`CANCELLED`] once the user has called the export off.
    pub fn check(&self) -> Result<()> {
        match locked(&CANCELLED_JOBS)
            .as_ref()
            .is_some_and(|c| c.contains(&self.id))
        {
            true => Err(Error::msg(CANCELLED)),
            false => Ok(()),
        }
    }

    /// Says that `done` of `total` slides are done, and stops here if the export is cancelled.
    pub fn step(&self, done: usize, total: usize) -> Result<()> {
        self.check()?;
        (self.report)(Progress {
            job: self.id.clone(),
            done,
            total,
        });
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Some(running) = locked(&RUNNING).as_mut() {
            running.remove(&self.id);
        }
        if let Some(cancelled) = locked(&CANCELLED_JOBS).as_mut() {
            cancelled.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn a_job_reports_each_step_until_it_is_cancelled() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let job = {
            let seen = seen.clone();
            Job::start("job-steps", move |p| seen.lock().unwrap().push(p))
        };
        job.step(0, 3).unwrap();
        job.step(1, 3).unwrap();
        cancel("job-steps");
        let error = job.step(2, 3).unwrap_err().to_string();
        assert_eq!(error, CANCELLED);
        assert!(job.check().is_err());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "a cancelled step is not reported");
        assert_eq!(
            seen[1],
            Progress {
                job: "job-steps".into(),
                done: 1,
                total: 3
            }
        );
    }

    #[test]
    fn cancelling_reaches_only_the_job_named_while_it_runs() {
        cancel("job-early");
        let job = Job::start("job-early", |_| {});
        assert!(job.check().is_ok(), "cancelled before it started: not it");
        let other = Job::start("job-other", |_| {});
        cancel("job-early");
        assert!(job.check().is_err());
        assert!(other.check().is_ok());
        drop(job);
        let again = Job::start("job-early", |_| {});
        assert!(
            again.check().is_ok(),
            "the next export of that name starts fresh"
        );
    }

    #[test]
    fn progress_goes_to_the_window_in_camel_case() {
        let progress = Progress {
            job: "a".into(),
            done: 2,
            total: 5,
        };
        assert_eq!(
            serde_json::to_string(&progress).unwrap(),
            r#"{"job":"a","done":2,"total":5}"#
        );
        assert!(Job::unattended().step(1, 2).is_ok());
    }
}
