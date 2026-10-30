/* Only the pthread subset used by Qwen/ingot. Mutexes are non-recursive. */
#pragma once
#include "compat.h"
typedef HANDLE pthread_t;
typedef SRWLOCK pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef INIT_ONCE pthread_once_t;
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
#define PTHREAD_COND_INITIALIZER CONDITION_VARIABLE_INIT
#define PTHREAD_ONCE_INIT INIT_ONCE_STATIC_INIT
int pthread_create(pthread_t *thread, const void *attr, void *(*fn)(void *), void *arg);
int pthread_join(pthread_t thread, void **result);
int pthread_once(pthread_once_t *once, void (*fn)(void));
static inline pthread_t pthread_self(void) { return (HANDLE)(uintptr_t)GetCurrentThreadId(); }
static inline int pthread_mutex_init(pthread_mutex_t *m, const void *a) {
    (void)a; InitializeSRWLock(m); return 0;
}
static inline int pthread_mutex_lock(pthread_mutex_t *m) { AcquireSRWLockExclusive(m); return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { ReleaseSRWLockExclusive(m); return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_cond_init(pthread_cond_t *c, const void *a) {
    (void)a; InitializeConditionVariable(c); return 0;
}
static inline int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) {
    return SleepConditionVariableSRW(c, m, INFINITE, 0) ? 0 : EINVAL;
}
static inline int pthread_cond_signal(pthread_cond_t *c) { WakeConditionVariable(c); return 0; }
static inline int pthread_cond_broadcast(pthread_cond_t *c) { WakeAllConditionVariable(c); return 0; }
static inline int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
